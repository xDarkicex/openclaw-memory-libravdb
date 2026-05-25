import { LibravDBClient, resolveClientEndpoint } from "./libravdb-client.js";
import type { LoggerLike, PluginConfig } from "./types.js";
import { formatError } from "./format-error.js";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

export type ClientGetter = () => Promise<LibravDBClient>;
export const DEFAULT_RPC_TIMEOUT_MS = 30000;
export const STARTUP_HEALTH_TIMEOUT_MS = 2000;

export const VALID_TLS_MODES = ["auto", "tls", "insecure"] as const;
export type ValidTlsMode = typeof VALID_TLS_MODES[number];
const isTlsModeValid = (m: string): m is ValidTlsMode =>
  VALID_TLS_MODES.includes(m as ValidTlsMode);

export function resolveStartupHealthTimeoutMs(cfg: PluginConfig): number {
  return Math.max(STARTUP_HEALTH_TIMEOUT_MS, cfg.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS);
}

export interface LifecycleHint {
  hook: "before_reset" | "session_end";
  reason?: string;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir?: string;
  messageCount?: number;
  durationMs?: number;
  transcriptArchived?: boolean;
  nextSessionId?: string;
  nextSessionKey?: string;
}

export type RuntimeShutdownTask = () => Promise<void> | void;

export interface PluginRuntime {
  getClient: ClientGetter;
  emitLifecycleHint(hint: LifecycleHint): Promise<void>;
  onShutdown(task: RuntimeShutdownTask): void;
  shutdown(): Promise<void>;
}

export function daemonProvisioningHint(): string {
  return "If you installed the npm package, install and start libravdbd separately; the package does not provision the daemon binary, ONNX Runtime, or model assets.";
}

export function validateEmbeddingConfig(cfg: PluginConfig): void {
  if (cfg.embeddingBackend !== "onnx-local") {
    return;
  }

  const runtimePath = cfg.embeddingRuntimePath?.trim();
  const modelPath = cfg.embeddingModelPath?.trim();
  if (!runtimePath || !modelPath) {
    throw new Error(
      `LibraVDB: embeddingBackend="onnx-local" requires embeddingRuntimePath and embeddingModelPath. ` +
      `Start libravdbd with matching LIBRAVDB_ONNX_RUNTIME and LIBRAVDB_EMBEDDING_MODEL values.`,
    );
  }

  if (!shouldValidateLocalEmbeddingPaths(cfg)) {
    return;
  }

  if (!pathExistsAsFile(runtimePath)) {
    throw new Error(
      `LibraVDB: embeddingRuntimePath must point to a readable ONNX Runtime library: ${runtimePath}`,
    );
  }

  if (!pathExistsAsDirectory(modelPath) || !pathExistsAsFile(path.join(modelPath, "embedding.json"))) {
    throw new Error(
      `LibraVDB: embeddingModelPath must point to a directory containing embedding.json: ${modelPath}`,
    );
  }
}

export function createPluginRuntime(
  cfg: PluginConfig,
  logger: LoggerLike = console,
): PluginRuntime {
  let started: Promise<LibravDBClient> | null = null;
  let stopped = false;
  let shuttingDown = false;
  const shutdownTasks: RuntimeShutdownTask[] = [];

  const ensureStarted = async (): Promise<LibravDBClient> => {
    if (stopped) {
      throw new Error("LibraVDB plugin runtime has been shut down");
    }
    if (!started) {
      let client: LibravDBClient | undefined;
      started = (async () => {
        validateEmbeddingConfig(cfg);
        validateTlsConfig(cfg, logger);

        client = new LibravDBClient({
          endpoint: cfg.grpcEndpoint || cfg.sidecarPath,
          timeoutMs: cfg.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
          tlsCaPath: cfg.grpcEndpointTlsCa,
          tlsMode: cfg.grpcEndpointTlsMode,
          tlsClientCertPath: cfg.grpcEndpointTlsClientCert,
          tlsClientKeyPath: cfg.grpcEndpointTlsClientKey,
        });

        await client.bootstrapHandshake();
        return client;
      })().catch((error) => {
        started = null;
        client?.close();
        throw enrichStartupError(error);
      });
    }
    return await started;
  };

  return {
    async getClient() {
      return await ensureStarted();
    },
    async emitLifecycleHint(hint: LifecycleHint) {
      try {
        const client = await ensureStarted();
        await client.sessionLifecycleHint(hint);
      } catch (error) {
        logger.warn?.(`LibraVDB lifecycle hint dropped: ${formatError(error)}`);
      }
    },
    onShutdown(task: RuntimeShutdownTask) {
      if (stopped || shuttingDown) {
        return;
      }
      shutdownTasks.push(task);
    },
    async shutdown() {
      if (stopped || shuttingDown) {
        return;
      }
      shuttingDown = true;

      for (const task of shutdownTasks.splice(0).reverse()) {
        try {
          await task();
        } catch (error) {
          logger.warn?.(`LibraVDB shutdown task failed: ${formatError(error)}`);
        }
      }

      stopped = true;
      if (!started) {
        return;
      }
      const client = started;
      started = null;
      try {
        const resolved = await client;
        try {
          await resolved.flush({});
        } catch (error) {
          logger.warn?.(`LibraVDB flush failed during shutdown: ${formatError(error)}`);
        } finally {
          resolved.close();
        }
      } catch {
        // startup may have failed before client resolution; nothing to flush or close
      }
    },
  };
}

function shouldValidateLocalEmbeddingPaths(cfg: PluginConfig): boolean {
  // Resolve the same endpoint the client will use — respects LIBRAVDB_GRPC_ENDPOINT env var
  const endpoint = resolveClientEndpoint(cfg.grpcEndpoint || cfg.sidecarPath).trim();
  if (!endpoint || endpoint === "auto" || endpoint.startsWith("unix:")) {
    return true;
  }
  if (!endpoint.startsWith("tcp:")) {
    return false;
  }

  const target = endpoint.slice("tcp:".length);
  const host = target.startsWith("[")
    ? target.slice(1, target.indexOf("]"))
    : target.split(":")[0];
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function pathExistsAsFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function pathExistsAsDirectory(dirPath: string): boolean {
  try {
    return existsSync(dirPath) && statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function validateTlsConfig(cfg: PluginConfig, logger: LoggerLike): void {
  if (
    cfg.grpcEndpointTlsMode !== undefined &&
    !isTlsModeValid(cfg.grpcEndpointTlsMode)
  ) {
    throw new Error(
      `LibraVDB: invalid grpcEndpointTlsMode "${cfg.grpcEndpointTlsMode}" — ` +
      `must be "auto", "tls", or "insecure"`,
    );
  }

  const hasClientCert = cfg.grpcEndpointTlsClientCert !== undefined;
  const hasClientKey = cfg.grpcEndpointTlsClientKey !== undefined;
  if (hasClientCert !== hasClientKey) {
    throw new Error(
      "LibraVDB: grpcEndpointTlsClientCert and " +
      "grpcEndpointTlsClientKey must both be set or both be omitted",
    );
  }

  if (cfg.grpcEndpointTlsMode === "insecure") {
    if (cfg.grpcEndpointTlsCa) {
      logger.warn?.(
        `LibraVDB: grpcEndpointTlsCa is set but grpcEndpointTlsMode ` +
        `is "insecure" — the CA file will not be used`,
      );
    }
    if (cfg.grpcEndpointTlsClientCert) {
      logger.warn?.(
        `LibraVDB: grpcEndpointTlsClientCert is set but ` +
        `grpcEndpointTlsMode is "insecure" — client certificate ` +
        `will not be sent`,
      );
    }
  }
}

export function enrichStartupError(error: unknown, healthMessage?: string): Error {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.trim() || "LibraVDB daemon startup failed";
  if (message.includes("package does not provision the daemon binary")) {
    return error instanceof Error ? error : new Error(message);
  }
  const shouldHint = /health check|daemon unavailable|connection refused|ECONNREFUSED|ENOENT|fallback mode|ONNX Runtime|embedder/i.test(
    `${message} ${healthMessage ?? ""}`,
  );
  if (!shouldHint) {
    return error instanceof Error ? error : new Error(message);
  }

  const detail = healthMessage?.trim();
  const prefix = detail && !message.includes(detail) ? `${message}: ${detail}` : message;
  return new Error(`${prefix}. ${daemonProvisioningHint()}`);
}
