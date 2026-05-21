import { createPromiseClient } from "@connectrpc/connect";
import type { Interceptor } from "@connectrpc/connect";
import type { PartialMessage } from "@bufbuild/protobuf";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { LibravDB } from "@xdarkicex/libravdb-contracts/client";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type {
  AfterTurnKernelRequest,
  AfterTurnKernelResponse,
  AssembleContextInternalRequest,
  AssembleContextInternalResponse,
  BootstrapSessionKernelRequest,
  BootstrapSessionKernelResponse,
  CompactSessionRequest,
  CompactSessionResponse,
  DeleteAuthoredDocumentRequest,
  DeleteAuthoredDocumentResponse,
  DreamPromotionResponse,
  ExportMemoryRequest,
  ExportMemoryResponse,
  FlushNamespaceRequest,
  FlushNamespaceResponse,
  FlushRequest,
  FlushResponse,
  HealthRequest,
  HealthResponse,
  IngestMarkdownDocumentRequest,
  IngestMarkdownDocumentResponse,
  IngestMessageKernelRequest,
  IngestMessageKernelResponse,
  ListCollectionRequest,
  ListCollectionResponse,
  ListLifecycleJournalRequest,
  ListLifecycleJournalResponse,
  MarkMemorySupersededRequest,
  MarkMemorySupersededResponse,
  MemoryStatusRequest,
  MemoryStatusResponse,
  PromoteDreamEntriesRequest,
  RankCandidatesRequest,
  RankCandidatesResponse,
  RebuildIndexRequest,
  RebuildIndexResponse,
  ReindexAuthoredDocumentRequest,
  ReindexAuthoredDocumentResponse,
  SearchTextCollectionsRequest,
  SearchTextRequest,
  SearchTextResponse,
  SessionLifecycleHintRequest,
  SessionLifecycleHintResponse,
} from "@xdarkicex/libravdb-contracts";

export interface LibravDBClientOptions {
  endpoint?: string;
  secret?: string;
  timeoutMs?: number;
  tlsCaPath?: string;
  tlsMode?: "auto" | "tls" | "insecure";
  tlsClientCertPath?: string;
  tlsClientKeyPath?: string;
}

export function resolveClientEndpoint(configuredEndpoint?: string): string {
  if (configuredEndpoint && configuredEndpoint !== "auto") return configuredEndpoint;
  if (process.env.LIBRAVDB_GRPC_ENDPOINT) return process.env.LIBRAVDB_GRPC_ENDPOINT;

  if (process.platform === "win32") return "tcp:127.0.0.1:37421";

  const sockName = "libravdb.sock";
  const candidateDirs = [
    path.join(os.homedir(), ".libravdbd", "run"),
    "/opt/homebrew/var/libravdbd/run",
    "/usr/local/var/libravdbd/run",
  ];

  for (const dir of candidateDirs) {
    const fullPath = path.join(dir, sockName);
    if (fs.existsSync(fullPath)) return `unix:${fullPath}`;
  }
  return `unix:${path.join(os.homedir(), ".libravdbd", "run", sockName)}`;
}

type PromiseClient = ReturnType<typeof createPromiseClient<typeof LibravDB>>;

// ---------------------------------------------------------------------------
// Extracted for testability — exported so tests can exercise the nonce
// lifecycle state machine directly without mocking Connect-ES internals.
// ---------------------------------------------------------------------------

interface RpcMutex {
  current: Promise<void>;
  lock(): Promise<() => void>;
}

function createRpcMutex(): RpcMutex {
  return {
    current: Promise.resolve(),
    async lock() {
      let release!: () => void;
      const p = new Promise<void>(r => release = r);
      const prev = this.current;
      this.current = prev.then(() => p);
      await prev;
      return release;
    }
  };
}

export interface AuthInterceptorState {
  readonly secret: string | undefined;
  nonceHex: string | undefined;
  bootstrap(): Promise<void>;
  readonly rpcMutex: RpcMutex;
}

export function createAuthInterceptor(
  state: AuthInterceptorState,
): Interceptor {
  return (next) => async (req) => {
    // Health does not participate in the nonce chain — bypass the
    // mutex entirely so recovery can call Health without deadlocking.
    if (req.method.name === "Health") {
      return next(req);
    }

    const release = await state.rpcMutex.lock();
    try {
      // Lost the nonce? Recover inside the lock so queued requests
      // wait for the chain to be restored instead of failing spuriously.
      if (state.secret && !state.nonceHex) {
        await state.bootstrap();
        if (!state.nonceHex) {
          throw new Error("LibraVDB: bootstrap handshake did not return a nonce");
        }
      }

      if (state.secret && state.nonceHex) {
        const hmac = createHmac("sha256", state.secret);
        hmac.update(state.nonceHex);
        req.header.set("x-libravdb-nonce", state.nonceHex);
        req.header.set("x-libravdb-auth", hmac.digest("hex"));
      }

      let res;
      try {
        res = await next(req);
      } catch (error) {
        if (state.secret && state.nonceHex) {
          state.nonceHex = undefined;
        }
        throw error;
      }

      if (state.secret) {
        const nextNonce = res.header.get("x-libravdb-nonce") || res.trailer.get("x-libravdb-nonce");
        if (nextNonce) {
          state.nonceHex = nextNonce;
        } else {
          state.nonceHex = undefined;
        }
      }
      return res;
    } finally {
      release();
    }
  };
}

export class LibravDBClient {
  private client: PromiseClient;
  private readonly secret: string | undefined;
  private nonceHex: string | undefined;
  private closed = false;

  constructor(options: LibravDBClientOptions = {}) {
    this.secret = options.secret ?? loadSecretFromEnv();

    const rawEndpoint = resolveClientEndpoint(options.endpoint);
    const isUnix = rawEndpoint.startsWith("unix:");
    const socketPath = isUnix ? rawEndpoint.slice(5) : undefined;
    const credMode = resolveCredentialMode(rawEndpoint, options.tlsMode);
    const isInsecure = isUnix || credMode === "insecure";
    const targetUrl = isUnix 
      ? "http://localhost" 
      : rawEndpoint.replace(/^tcp:/, isInsecure ? "http://" : "https://");

    let rootCerts: Buffer | null = null;
    let clientKey: Buffer | null = null;
    let clientCert: Buffer | null = null;

    if (!isInsecure && options.tlsCaPath) {
      rootCerts = fs.readFileSync(options.tlsCaPath);
    }
    if (options.tlsClientCertPath && options.tlsClientKeyPath) {
      clientCert = fs.readFileSync(options.tlsClientCertPath);
      clientKey = fs.readFileSync(options.tlsClientKeyPath);
    }

    const rpcMutex = createRpcMutex();
    const self = this;

    const authInterceptor = createAuthInterceptor({
      secret: this.secret,
      get nonceHex() { return self.nonceHex; },
      set nonceHex(v: string | undefined) { self.nonceHex = v; },
      bootstrap: () => self.bootstrapHandshake(),
      rpcMutex,
    });

    const transport = createGrpcTransport({
      baseUrl: targetUrl,
      httpVersion: "2",
      nodeOptions: isUnix
        ? { createConnection: () => net.connect(socketPath!) } as any
        : {
            ...(rootCerts ? { ca: rootCerts } : {}),
            ...(clientKey ? { key: clientKey } : {}),
            ...(clientCert ? { cert: clientCert } : {}),
            ...(isInsecure ? { rejectUnauthorized: false } : {}),
          },
      defaultTimeoutMs: options.timeoutMs ?? 30000,
      interceptors: [authInterceptor],
    });

    this.client = createPromiseClient(LibravDB, transport);
  }

  async bootstrapHandshake(): Promise<void> {
    this.guardOpen();
    try {
      await this.client.health(
        { service: "" },
        {
          onHeader: (headers) => {
            const nonce = headers.get("x-libravdb-nonce");
            if (nonce) this.nonceHex = nonce;
          },
        },
      );
    } catch (error) {
      throw new Error(
        `LibraVDB: failed to handshake with daemon: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private guardOpen(): void {
    if (this.closed) {
      throw new Error("LibravDB client is closed");
    }
  }

  // ── Session lifecycle ────────────────────────────────────────────

  async health(req: PartialMessage<HealthRequest> = {}): Promise<HealthResponse> {
    this.guardOpen();
    return this.client.health(req);
  }

  async status(req: PartialMessage<MemoryStatusRequest> = {}): Promise<MemoryStatusResponse> {
    this.guardOpen();
    return this.client.status(req);
  }

  async flush(req: PartialMessage<FlushRequest> = {}): Promise<FlushResponse> {
    this.guardOpen();
    return this.client.flush(req);
  }

  async sessionLifecycleHint(
    req: PartialMessage<SessionLifecycleHintRequest>,
  ): Promise<SessionLifecycleHintResponse> {
    this.guardOpen();
    return this.client.sessionLifecycleHint(req);
  }

  async listLifecycleJournal(
    req: PartialMessage<ListLifecycleJournalRequest>,
  ): Promise<ListLifecycleJournalResponse> {
    this.guardOpen();
    return this.client.listLifecycleJournal(req);
  }

  // ── Ingest ───────────────────────────────────────────────────────

  async ingestMarkdownDocument(
    req: PartialMessage<IngestMarkdownDocumentRequest>,
  ): Promise<IngestMarkdownDocumentResponse> {
    this.guardOpen();
    return this.client.ingestMarkdownDocument(req);
  }

  async promoteDreamEntries(
    req: PartialMessage<PromoteDreamEntriesRequest>,
  ): Promise<DreamPromotionResponse> {
    this.guardOpen();
    return this.client.promoteDreamEntries(req);
  }

  async reindexAuthoredDocument(
    req: PartialMessage<ReindexAuthoredDocumentRequest>,
  ): Promise<ReindexAuthoredDocumentResponse> {
    this.guardOpen();
    return this.client.reindexAuthoredDocument(req);
  }

  async deleteAuthoredDocument(
    req: PartialMessage<DeleteAuthoredDocumentRequest>,
  ): Promise<DeleteAuthoredDocumentResponse> {
    this.guardOpen();
    return this.client.deleteAuthoredDocument(req);
  }

  async markMemorySuperseded(
    req: PartialMessage<MarkMemorySupersededRequest>,
  ): Promise<MarkMemorySupersededResponse> {
    this.guardOpen();
    return this.client.markMemorySuperseded(req);
  }

  // ── Search / query ───────────────────────────────────────────────

  async searchText(req: PartialMessage<SearchTextRequest>): Promise<SearchTextResponse> {
    this.guardOpen();
    return this.client.searchText(req);
  }

  async searchTextCollections(
    req: PartialMessage<SearchTextCollectionsRequest>,
  ): Promise<SearchTextResponse> {
    this.guardOpen();
    return this.client.searchTextCollections(req);
  }

  async listCollection(req: PartialMessage<ListCollectionRequest>): Promise<ListCollectionResponse> {
    this.guardOpen();
    return this.client.listCollection(req);
  }

  // ── Memory ───────────────────────────────────────────────────────

  async exportMemory(req: PartialMessage<ExportMemoryRequest>): Promise<ExportMemoryResponse> {
    this.guardOpen();
    return this.client.exportMemory(req);
  }

  async flushNamespace(req: PartialMessage<FlushNamespaceRequest>): Promise<FlushNamespaceResponse> {
    this.guardOpen();
    return this.client.flushNamespace(req);
  }

  // ── Index ────────────────────────────────────────────────────────

  async rebuildIndex(
    req: PartialMessage<RebuildIndexRequest>,
    opts?: { timeoutMs?: number },
  ): Promise<RebuildIndexResponse> {
    this.guardOpen();
    return this.client.rebuildIndex(req, opts);
  }

  // ── Kernel ───────────────────────────────────────────────────────

  async bootstrapSessionKernel(
    req: PartialMessage<BootstrapSessionKernelRequest>,
  ): Promise<BootstrapSessionKernelResponse> {
    this.guardOpen();
    return this.client.bootstrapSessionKernel(req);
  }

  async ingestMessageKernel(
    req: PartialMessage<IngestMessageKernelRequest>,
  ): Promise<IngestMessageKernelResponse> {
    this.guardOpen();
    return this.client.ingestMessageKernel(req);
  }

  async afterTurnKernel(
    req: PartialMessage<AfterTurnKernelRequest>,
  ): Promise<AfterTurnKernelResponse> {
    this.guardOpen();
    return this.client.afterTurnKernel(req);
  }

  async assembleContextInternal(
    req: PartialMessage<AssembleContextInternalRequest>,
  ): Promise<AssembleContextInternalResponse> {
    this.guardOpen();
    return this.client.assembleContextInternal(req);
  }

  async compactSession(
    req: PartialMessage<CompactSessionRequest>,
  ): Promise<CompactSessionResponse> {
    this.guardOpen();
    return this.client.compactSession(req);
  }

  async rankCandidates(
    req: PartialMessage<RankCandidatesRequest>,
  ): Promise<RankCandidatesResponse> {
    this.guardOpen();
    return this.client.rankCandidates(req);
  }

  close(): void {
    this.closed = true;
  }
}

function resolveCredentialMode(
  endpoint: string,
  tlsMode?: "auto" | "tls" | "insecure",
): "insecure" | "tls" {
  if (tlsMode === "tls") return "tls";
  if (tlsMode === "insecure") return "insecure";
  const target = endpoint.startsWith("tcp:") ? endpoint.slice(4) : endpoint;
  if (target.startsWith("unix:")) return "insecure";
  const host = extractHost(target);
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1"
    ? "insecure"
    : "tls";
}

function extractHost(target: string): string {
  const withoutDns = target.startsWith("dns:///") ? target.slice("dns:///".length) : target;
  if (withoutDns.startsWith("[")) {
    const close = withoutDns.indexOf("]");
    return close > 0 ? withoutDns.slice(1, close) : withoutDns;
  }
  const sep = withoutDns.lastIndexOf(":");
  return sep > 0 ? withoutDns.slice(0, sep) : withoutDns;
}

function loadSecretFromEnv(): string | undefined {
  const secret = process.env.LIBRAVDB_AUTH_SECRET;
  if (secret) return secret;
  const secretPath = process.env.LIBRAVDB_AUTH_SECRET_FILE;
  if (secretPath) {
    try {
      return fs.readFileSync(secretPath, "utf8").trim();
    } catch {
      return undefined;
    }
  }
  return undefined;
}
