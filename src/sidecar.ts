import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { LoggerLike, PluginConfig, SidecarHandle, SidecarSocket } from "./types.js";

type CloseHandler = () => void;
type DataHandler = (chunk: string) => void;
type ErrorHandler = (error: Error) => void;

export interface SidecarRuntime {
  resolveEndpoint(cfg: PluginConfig): string | Promise<string>;
  createSocket(endpoint: string): SidecarSocket;
  scheduleRestart(delayMs: number, restart: () => void): void;
}

class PlaceholderSocket implements SidecarSocket {
  private readonly onData = new Set<DataHandler>();
  private readonly onClose = new Set<CloseHandler>();
  private readonly connectOnce = new Set<CloseHandler>();
  private readonly errorOnce = new Set<ErrorHandler>();

  constructor() {
    queueMicrotask(() => {
      for (const handler of this.connectOnce) {
        handler();
      }
      this.connectOnce.clear();
    });
  }

  setEncoding(_encoding: string): void {}

  on(event: "data" | "close", handler: DataHandler | CloseHandler): void {
    if (event === "data") {
      this.onData.add(handler as DataHandler);
      return;
    }
    this.onClose.add(handler as CloseHandler);
  }

  once(event: "connect" | "error", handler: CloseHandler | ErrorHandler): void {
    if (event === "connect") {
      this.connectOnce.add(handler as CloseHandler);
      return;
    }
    this.errorOnce.add(handler as ErrorHandler);
  }

  write(chunk: string): void {
    try {
      const msg = JSON.parse(chunk);
      const response = JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: msg.method === "health" ? { ok: true } : {},
      });
      for (const handler of this.onData) {
        handler(`${response}\n`);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      for (const handler of this.errorOnce) {
        handler(err);
      }
      this.errorOnce.clear();
    }
  }

  destroy(): void {
    for (const handler of this.onClose) {
      handler();
    }
  }
}

class SupervisorSocket implements SidecarSocket {
  private readonly onData = new Set<DataHandler>();
  private readonly onClose = new Set<CloseHandler>();
  private readonly connectOnce = new Set<CloseHandler>();
  private readonly errorOnce = new Set<ErrorHandler>();
  private current?: SidecarSocket;
  private encoding = "utf8";
  private generation = 0;

  bind(socket: SidecarSocket): void {
    this.current = socket;
    this.generation += 1;
    const generation = this.generation;

    socket.setEncoding(this.encoding);
    socket.on("data", (chunk) => {
      if (generation !== this.generation) {
        return;
      }
      for (const handler of this.onData) {
        handler(chunk);
      }
    });
    socket.on("close", () => {
      if (generation !== this.generation) {
        return;
      }
      for (const handler of this.onClose) {
        handler();
      }
    });

    for (const handler of this.connectOnce) {
      handler();
    }
    this.connectOnce.clear();
  }

  setEncoding(encoding: string): void {
    this.encoding = encoding;
    this.current?.setEncoding(encoding);
  }

  on(event: "data" | "close", handler: DataHandler | CloseHandler): void {
    if (event === "data") {
      this.onData.add(handler as DataHandler);
      return;
    }
    this.onClose.add(handler as CloseHandler);
  }

  once(event: "connect" | "error", handler: CloseHandler | ErrorHandler): void {
    if (event === "connect") {
      if (this.current) {
        (handler as CloseHandler)();
        return;
      }
      this.connectOnce.add(handler as CloseHandler);
      return;
    }
    this.errorOnce.add(handler as ErrorHandler);
  }

  write(chunk: string): void {
    if (!this.current) {
      throw new Error("Sidecar socket unavailable");
    }
    this.current.write(chunk);
  }

  destroy(): void {
    this.current?.destroy();
  }
}

class SidecarSupervisor implements SidecarHandle {
  private retries = 0;
  private degraded = false;
  private shuttingDown = false;
  public socket: SidecarSocket;

  constructor(
    private readonly cfg: PluginConfig,
    private readonly logger: LoggerLike,
    private readonly runtime: SidecarRuntime,
  ) {
    this.socket = new SupervisorSocket();
  }

  async start(): Promise<SidecarSocket> {
    const endpoint = await this.runtime.resolveEndpoint(this.cfg);
    const socket = await this.connectEndpoint(endpoint);
    if (this.socket instanceof SupervisorSocket) {
      this.socket.bind(socket);
    } else {
      this.socket = socket;
    }
    return socket;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.socket.destroy();
  }

  private async connectEndpoint(endpoint: string): Promise<SidecarSocket> {
    const socket = this.runtime.createSocket(endpoint);
    socket.on("close", () => {
      void this.handleExit(1);
    });

    if (isTcpEndpoint(endpoint)) {
      this.logger.info?.(`[libravdb] using TCP endpoint ${endpoint}`);
    } else {
      this.logger.info?.(`[libravdb] using Unix socket ${endpoint}`);
    }

    return await new Promise<SidecarSocket>((resolve, reject) => {
      socket.once("connect", () => resolve(socket));
      socket.once("error", (error) => reject(formatConnectionError(endpoint, error)));
    });
  }

  private async handleExit(code: number | null): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    if (code === 0) {
      return;
    }

    const maxRetries = this.cfg.maxRetries ?? 3;
    if (this.retries >= maxRetries) {
      this.logger.error("[libravdb] sidecar retries exhausted; degraded mode");
      this.degraded = true;
      return;
    }

    const backoffMs = computeBackoffMs(this.retries);
    this.retries += 1;
    this.runtime.scheduleRestart(backoffMs, () => {
      void this.start().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`[libravdb] sidecar reconnect failed: ${message}`);
      });
    });
  }
}

export async function startSidecar(
  cfg: PluginConfig,
  logger: LoggerLike = console,
  runtime: SidecarRuntime = createDefaultRuntime(),
): Promise<SidecarHandle> {
  const supervisor = new SidecarSupervisor(cfg, logger, runtime);
  await supervisor.start();
  return supervisor;
}

export function computeBackoffMs(retries: number): number {
  return Math.min(500 * Math.pow(2, retries), 16000);
}

export function isTcpEndpoint(endpoint: string): boolean {
  return endpoint.startsWith("tcp:");
}

export function resolveEndpoint(cfg: PluginConfig): string {
  const endpoint = resolveConfiguredEndpoint(cfg);
  return endpoint.replace(/^unix:/, "");
}

export function resolveConfiguredEndpoint(cfg: PluginConfig): string {
  const value = cfg.sidecarPath?.trim();
  if (!value || value === "auto") {
    return defaultEndpoint();
  }
  if (!isConfiguredEndpoint(value)) {
    throw new Error(
      `LibraVDB sidecarPath must be a daemon endpoint like unix:/path/to/libravdb.sock or tcp:127.0.0.1:37421. Executable paths are no longer supported.`,
    );
  }
  return value;
}

export function daemonProvisioningHint(): string {
  return "If you installed the npm package, install and start libravdbd separately; the package does not provision the daemon binary, ONNX Runtime, or model assets.";
}

export function defaultEndpoint(platform = process.platform, homeDir = os.homedir()): string {
  // Honour the daemon's own env var first (set by Homebrew LaunchAgent / systemd unit).
  const envEndpoint = process.env.LIBRAVDB_RPC_ENDPOINT?.trim();
  if (envEndpoint && isConfiguredEndpoint(envEndpoint)) {
    return envEndpoint;
  }

  if (platform === "win32") {
    return "tcp:127.0.0.1:37421";
  }

  const sockName = "libravdb.sock";
  const candidateDirs = [
    // User-local (npm plugin convention)
    homeDir?.trim() ? path.join(homeDir, ".clawdb", "run") : null,
    // Homebrew (Apple Silicon) — matches the Homebrew formula LaunchAgent
    "/opt/homebrew/var/clawdb/run",
    // Homebrew (Intel Mac) / manual Linux installs
    "/usr/local/var/clawdb/run",
  ].filter((d): d is string => d !== null);

  for (const dir of candidateDirs) {
    const sockPath = path.join(dir, sockName);
    try {
      if (fs.existsSync(sockPath)) {
        return `unix:${sockPath}`;
      }
    } catch {
      // Permission error or similar — skip this candidate.
    }
  }

  // Fallback to the original user-local path so error messages stay familiar.
  const baseDir = homeDir?.trim()
    ? path.join(homeDir, ".clawdb", "run")
    : path.join(".", ".clawdb", "run");
  return `unix:${path.join(baseDir, sockName)}`;
}

export function buildSidecarEnv(cfg: PluginConfig): Record<string, string> {
  const env: Record<string, string> = {};

  if (cfg.dbPath) {
    env.LIBRAVDB_DB_PATH = cfg.dbPath;
  }
  if (cfg.embeddingRuntimePath) {
    env.LIBRAVDB_ONNX_RUNTIME = cfg.embeddingRuntimePath;
  }
  if (cfg.embeddingBackend) {
    env.LIBRAVDB_EMBEDDING_BACKEND = cfg.embeddingBackend;
  }
  if (cfg.embeddingProfile) {
    env.LIBRAVDB_EMBEDDING_PROFILE = cfg.embeddingProfile;
  }
  if (cfg.fallbackProfile) {
    env.LIBRAVDB_FALLBACK_PROFILE = cfg.fallbackProfile;
  }
  if (cfg.embeddingModelPath) {
    env.LIBRAVDB_EMBEDDING_MODEL = cfg.embeddingModelPath;
  }
  if (cfg.embeddingTokenizerPath) {
    env.LIBRAVDB_EMBEDDING_TOKENIZER = cfg.embeddingTokenizerPath;
  }
  if (typeof cfg.embeddingDimensions === "number" && cfg.embeddingDimensions > 0) {
    env.LIBRAVDB_EMBEDDING_DIMENSIONS = String(cfg.embeddingDimensions);
  }
  if (typeof cfg.embeddingNormalize === "boolean") {
    env.LIBRAVDB_EMBEDDING_NORMALIZE = String(cfg.embeddingNormalize);
  }
  if (cfg.summarizerBackend) {
    env.LIBRAVDB_SUMMARIZER_BACKEND = cfg.summarizerBackend;
  }
  if (cfg.summarizerProfile) {
    env.LIBRAVDB_SUMMARIZER_PROFILE = cfg.summarizerProfile;
  }
  if (cfg.summarizerRuntimePath) {
    env.LIBRAVDB_SUMMARIZER_RUNTIME = cfg.summarizerRuntimePath;
  }
  if (cfg.summarizerModelPath) {
    env.LIBRAVDB_SUMMARIZER_MODEL_PATH = cfg.summarizerModelPath;
  }
  if (cfg.summarizerTokenizerPath) {
    env.LIBRAVDB_SUMMARIZER_TOKENIZER = cfg.summarizerTokenizerPath;
  }
  if (cfg.summarizerModel) {
    env.LIBRAVDB_SUMMARIZER_MODEL = cfg.summarizerModel;
  }
  if (cfg.summarizerEndpoint) {
    env.LIBRAVDB_SUMMARIZER_ENDPOINT = cfg.summarizerEndpoint;
  }
  if (cfg.ollamaUrl && !env.LIBRAVDB_SUMMARIZER_ENDPOINT) {
    env.LIBRAVDB_SUMMARIZER_ENDPOINT = cfg.ollamaUrl;
  }
  if (cfg.compactModel && !env.LIBRAVDB_SUMMARIZER_MODEL) {
    env.LIBRAVDB_SUMMARIZER_MODEL = cfg.compactModel;
  }
  if (cfg.gatingWeights?.w1c != null) {
    env.LIBRAVDB_GATING_W1C = String(cfg.gatingWeights.w1c);
  }
  if (cfg.gatingWeights?.w2c != null) {
    env.LIBRAVDB_GATING_W2C = String(cfg.gatingWeights.w2c);
  }
  if (cfg.gatingWeights?.w3c != null) {
    env.LIBRAVDB_GATING_W3C = String(cfg.gatingWeights.w3c);
  }
  if (cfg.gatingWeights?.w1t != null) {
    env.LIBRAVDB_GATING_W1T = String(cfg.gatingWeights.w1t);
  }
  if (cfg.gatingWeights?.w2t != null) {
    env.LIBRAVDB_GATING_W2T = String(cfg.gatingWeights.w2t);
  }
  if (cfg.gatingWeights?.w3t != null) {
    env.LIBRAVDB_GATING_W3T = String(cfg.gatingWeights.w3t);
  }
  if (typeof cfg.gatingTechNorm === "number" && cfg.gatingTechNorm > 0) {
    env.LIBRAVDB_GATING_TECH_NORM = String(cfg.gatingTechNorm);
  }
  if (typeof cfg.ingestionGateThreshold === "number" && cfg.ingestionGateThreshold >= 0) {
    env.LIBRAVDB_GATING_THRESHOLD = String(cfg.ingestionGateThreshold);
  }
  if (typeof cfg.gatingCentroidK === "number" && cfg.gatingCentroidK > 0) {
    env.LIBRAVDB_GATING_CENTROID_K = String(cfg.gatingCentroidK);
  }
  if (typeof cfg.lifecycleJournalMaxEntries === "number" && cfg.lifecycleJournalMaxEntries > 0) {
    env.LIBRAVDB_LIFECYCLE_JOURNAL_MAX_ENTRIES = String(cfg.lifecycleJournalMaxEntries);
  }

  return env;
}

function createDefaultRuntime(): SidecarRuntime {
  return {
    resolveEndpoint(cfg) {
      return resolveEndpoint(cfg);
    },
    createSocket(endpoint) {
      if (isTcpEndpoint(endpoint)) {
        const address = endpoint.slice("tcp:".length);
        const separator = address.lastIndexOf(":");
        if (separator <= 0) {
          throw new Error(`Invalid TCP sidecar endpoint: ${endpoint}`);
        }
        return net.connect({
          host: address.slice(0, separator),
          port: Number(address.slice(separator + 1)),
        }) as unknown as SidecarSocket;
      }
      return net.connect(endpoint) as unknown as SidecarSocket;
    },
    scheduleRestart(delayMs, restart) {
      setTimeout(restart, delayMs);
    },
  };
}

function formatConnectionError(endpoint: string, error: Error): Error {
  const code = typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code
    : "";
  if (code === "ENOENT" || code === "ECONNREFUSED") {
    return new Error(
      `LibraVDB daemon unavailable at ${describeEndpoint(endpoint)}. ${daemonProvisioningHint()} Or set sidecarPath to a running daemon endpoint.`,
    );
  }
  return error;
}

function describeEndpoint(endpoint: string): string {
  if (isTcpEndpoint(endpoint)) {
    return endpoint;
  }
  return `unix:${endpoint}`;
}

function isConfiguredEndpoint(value?: string): boolean {
  return value?.startsWith("tcp:") === true || value?.startsWith("unix:") === true;
}

export { PlaceholderSocket };

export async function probeSidecarEndpoint(cfg: PluginConfig): Promise<string | null> {
  const endpoint = resolveConfiguredEndpoint(cfg);
  try {
    await new Promise<void>((resolve, reject) => {
      if (isTcpEndpoint(endpoint)) {
        const address = endpoint.slice("tcp:".length);
        const separator = address.lastIndexOf(":");
        if (separator <= 0) {
          reject(new Error("invalid tcp endpoint"));
          return;
        }
        const host = address.slice(0, separator);
        const port = Number(address.slice(separator + 1));
        const socket = net.connect({ host, port }, () => {
          socket.destroy();
          resolve();
        });
        socket.setTimeout(500);
        socket.on("error", reject);
        socket.on("timeout", reject);
      } else {
        const socketPath = endpoint.replace(/^unix:/, "");
        const socket = net.connect(socketPath, () => {
          socket.destroy();
          resolve();
        });
        socket.setTimeout(500);
        socket.on("error", reject);
        socket.on("timeout", reject);
      }
    });
    return endpoint;
  } catch {
    return null;
  }
}
