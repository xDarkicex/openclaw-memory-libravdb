import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

// Minimal type definitions for the dynamically-loaded gRPC service.
// These mirror the proto messages in api/proto/intelligence_kernel/v1/kernel.proto.

interface ProtoInitializeRequest {
  client_id: string;
  client_capabilities: Array<{ name: string; version: string }>;
  client_metadata: Record<string, string>;
}

interface ProtoInitializeResponse {
  session_id: string;
  connection_state: number;
  server_capabilities: Array<{ name: string; version: string; required: boolean }>;
  kernel_version: { major: number; minor: number; patch: number; prerelease: string };
  server_metadata: Record<string, string>;
}

interface ProtoAssembleContextRequest {
  session_id: string;
  session_key: string;
  user_id: string;
  query_text: string;
  visible_messages: Array<{ role: string; content: string; id: string }>;
  token_budget: number;
  config: Record<string, unknown>;
  emit_debug: boolean;
}

interface ProtoGetStatusResponse {
  ok: boolean;
  message: string;
  turn_count: number;
  memory_count: number;
  embedding_profile: string;
  abstractive_ready: boolean;
  kernel_version: { major: number; minor: number; patch: number; prerelease: string };
}

interface KernelServiceClient {
  InitializeSession(
    req: Record<string, unknown>,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: (err: grpc.ServiceError | null, resp: ProtoInitializeResponse) => void,
  ): void;
  AssembleContext(
    req: Record<string, unknown>,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: (err: grpc.ServiceError | null, resp: Record<string, unknown>) => void,
  ): void;
  RankCandidates(
    req: Record<string, unknown>,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: (err: grpc.ServiceError | null, resp: Record<string, unknown>) => void,
  ): void;
  IngestMessage(
    req: Record<string, unknown>,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: (err: grpc.ServiceError | null, resp: Record<string, unknown>) => void,
  ): void;
  AfterTurn(
    req: Record<string, unknown>,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: (err: grpc.ServiceError | null, resp: Record<string, unknown>) => void,
  ): void;
  BootstrapSession(
    req: Record<string, unknown>,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: (err: grpc.ServiceError | null, resp: Record<string, unknown>) => void,
  ): void;
  CompactSession(
    req: Record<string, unknown>,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: (err: grpc.ServiceError | null, resp: Record<string, unknown>) => void,
  ): void;
  GetStatus(
    req: Record<string, unknown>,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: (err: grpc.ServiceError | null, resp: ProtoGetStatusResponse) => void,
  ): void;
  close(): void;
}

interface ProtoPackage {
  intelligence_kernel: {
    v1: {
      IntelligenceKernel: typeof grpc.Client &
        { new (address: string, credentials: grpc.ChannelCredentials): KernelServiceClient };
    };
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The proto file is expected to be copied to dist/proto/ at build time.
// In source, it's at api/proto/.
const PROTO_PATH = path.resolve(__dirname, "./proto/intelligence_kernel/v1/kernel.proto");

export interface GrpcClientOptions {
  endpoint: string;
  secret?: string;
  timeoutMs?: number;
  tlsCaPath?: string;
  tlsMode?: "auto" | "tls" | "insecure";
  tlsClientCertPath?: string;
  tlsClientKeyPath?: string;
}

export function resolveGrpcTarget(endpoint: string): string {
  return endpoint.startsWith("tcp:") ? endpoint.substring(4) : endpoint;
}

/**
 * Selects gRPC credential mode based on endpoint address class.
 *
 * - Unix socket endpoints → plaintext (local-only transport)
 * - Loopback addresses (localhost, 127.0.0.1, ::1) → plaintext
 * - All other TCP and DNS targets → TLS
 *
 * resolveGrpcCredentials uses this classification to return the
 * appropriate grpc.ChannelCredentials. Pass tlsCaPath to load a
 * custom CA certificate PEM file for self-signed or private CA
 * deployments. Omit tlsCaPath for publicly trusted certificates
 * (Let's Encrypt, cert-manager) — the system CA pool is used.
 */
export function resolveGrpcCredentialMode(
  endpoint: string,
  tlsMode?: "auto" | "tls" | "insecure",
): "insecure" | "tls" {
  if (tlsMode === "tls") return "tls";
  if (tlsMode === "insecure") return "insecure";
  // "auto" or undefined — address-based heuristic
  const target = resolveGrpcTarget(endpoint).trim();
  if (target.startsWith("unix:")) return "insecure";
  const host = extractGrpcHost(target);
  return isLoopbackHost(host) ? "insecure" : "tls";
}

export function resolveGrpcCredentials(
  endpoint: string,
  tlsCaPath?: string,
  tlsMode?: "auto" | "tls" | "insecure",
  tlsClientCertPath?: string,
  tlsClientKeyPath?: string,
): grpc.ChannelCredentials {
  if (resolveGrpcCredentialMode(endpoint, tlsMode) === "insecure") {
    return grpc.credentials.createInsecure();
  }
  // tlsMode is "tls" or "auto"/undefined resolved to "tls"
  let rootCerts: Buffer | null = null;
  if (tlsCaPath) {
    try {
      rootCerts = fs.readFileSync(tlsCaPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `LibraVDB: failed to load TLS CA certificate from "${tlsCaPath}": ${msg}`,
      );
    }
  }
  // Client certificate and key must both be present or both absent
  const hasCert = tlsClientCertPath !== undefined;
  const hasKey = tlsClientKeyPath !== undefined;
  if (hasCert !== hasKey) {
    throw new Error(
      "LibraVDB: grpcEndpointTlsClientCert and grpcEndpointTlsClientKey " +
      "must both be set or both be omitted",
    );
  }
  let clientKey: Buffer | null = null;
  let clientCert: Buffer | null = null;
  if (tlsClientCertPath && tlsClientKeyPath) {
    try {
      clientCert = fs.readFileSync(tlsClientCertPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `LibraVDB: failed to load TLS client certificate from "${tlsClientCertPath}": ${msg}`,
      );
    }
    try {
      clientKey = fs.readFileSync(tlsClientKeyPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `LibraVDB: failed to load TLS client key from "${tlsClientKeyPath}": ${msg}`,
      );
    }
  }
  return grpc.credentials.createSsl(rootCerts, clientKey, clientCert);
}

function extractGrpcHost(target: string): string {
  const withoutDnsPrefix = target.startsWith("dns:///") ? target.slice("dns:///".length) : target;
  if (withoutDnsPrefix.startsWith("[")) {
    const closeBracket = withoutDnsPrefix.indexOf("]");
    return closeBracket > 0 ? withoutDnsPrefix.slice(1, closeBracket) : withoutDnsPrefix;
  }

  const portSeparator = withoutDnsPrefix.lastIndexOf(":");
  return portSeparator > 0 ? withoutDnsPrefix.slice(0, portSeparator) : withoutDnsPrefix;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export class GrpcKernelClient {
  private client: KernelServiceClient;
  private readonly secret: string | undefined;
  private readonly timeoutMs: number;
  private nonceHex: string | undefined;

  constructor(options: GrpcClientOptions) {
    this.secret = options.secret;
    this.timeoutMs = options.timeoutMs ?? 30000;

    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as unknown as ProtoPackage;
    const kernelService = protoDescriptor.intelligence_kernel.v1.IntelligenceKernel;

    const target = resolveGrpcTarget(options.endpoint);

    this.client = new kernelService(target, resolveGrpcCredentials(
      options.endpoint,
      options.tlsCaPath,
      options.tlsMode,
      options.tlsClientCertPath,
      options.tlsClientKeyPath,
    )) as unknown as KernelServiceClient;
  }

  private getMetadata(signed = true): grpc.Metadata {
    const md = new grpc.Metadata();
    if (this.secret && signed) {
      if (!this.nonceHex) {
        throw new Error("call initializeSession before authenticated RPCs");
      }
      // Challenge-response: HMAC(secret, nonce) — the secret is the HMAC key,
      // the server-issued nonce is the message. The previous implementation
      // swapped these, computing HMAC(nonce, secret), which is cryptographically
      // incorrect: the nonce is sent in the clear and must not be used as the key.
      const hmac = createHmac("sha256", this.secret);
      hmac.update(this.nonceHex);
      const signature = hmac.digest("hex");
      md.add("x-libravdb-auth", signature);
    }
    return md;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private call<T>(method: string, req: Record<string, unknown>, signed = true): Promise<T> {
    return new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + this.timeoutMs);
      // Dynamic dispatch on the gRPC stub — method names come from the proto service definition.
      (this.client as any)[method](req, this.getMetadata(signed), { deadline }, (err: grpc.ServiceError | null, resp: T) => {
        if (err) {
          reject(err);
        } else {
          resolve(resp);
        }
      });
    });
  }

  async initializeSession(req: Record<string, unknown>): Promise<ProtoInitializeResponse> {
    return new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + this.timeoutMs);
      this.client.InitializeSession(req, this.getMetadata(false), { deadline }, (err: grpc.ServiceError | null, resp: ProtoInitializeResponse) => {
        if (err) {
          reject(err);
          return;
        }
        const nonce = resp?.server_metadata?.nonce;
        if (this.secret && (typeof nonce !== "string" || nonce.length === 0)) {
          reject(new Error("InitializeSession response missing auth nonce"));
          return;
        }
        if (typeof nonce === "string" && nonce.length > 0) {
          this.nonceHex = nonce;
        }
        resolve(resp);
      });
    });
  }

  async assembleContext(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call("AssembleContext", req);
  }

  async rankCandidates(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call("RankCandidates", req);
  }

  async ingestMessage(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call("IngestMessage", req);
  }

  async afterTurn(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call("AfterTurn", req);
  }

  async bootstrapSession(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call("BootstrapSession", req);
  }

  async compactSession(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call("CompactSession", req);
  }

  async getStatus(req: Record<string, unknown> = {}): Promise<ProtoGetStatusResponse> {
    return this.call("GetStatus", req);
  }

  close(): void {
    this.client.close();
  }
}
