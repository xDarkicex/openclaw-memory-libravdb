import { RpcClient } from "./rpc.js";
import { GrpcKernelClient } from "./grpc-client.js";
import { daemonProvisioningHint, startSidecar } from "./sidecar.js";
import type { LoggerLike, PluginConfig, SidecarHandle } from "./types.js";
import { formatError } from "./format-error.js";
import { readFileSync } from "node:fs";

export type RpcGetter = () => Promise<RpcClient>;
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
  getRpc: RpcGetter;
  getKernel(): Promise<GrpcKernelClient | null>;
  emitLifecycleHint(hint: LifecycleHint): Promise<void>;
  onShutdown(task: RuntimeShutdownTask): void;
  shutdown(): Promise<void>;
}

export function createPluginRuntime(
  cfg: PluginConfig,
  logger: LoggerLike = console,
): PluginRuntime {
  let started: Promise<{ rpc: RpcClient; sidecar: SidecarHandle; kernel: GrpcKernelClient | null }> | null = null;
  let stopped = false;
  let shuttingDown = false;
  const shutdownTasks: RuntimeShutdownTask[] = [];

  const ensureStarted = async () => {
    if (stopped) {
      throw new Error("LibraVDB plugin runtime has been shut down");
    }
    if (!started) {
      started = (async () => {
        const sidecar = await startSidecar(cfg, logger);
        const rpc = new RpcClient(sidecar.socket, {
          timeoutMs: cfg.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
        });
        const health = await rpc.call<{ ok?: boolean; message?: string }>("health", {}, {
          timeoutMs: resolveStartupHealthTimeoutMs(cfg),
        });
        if (!health.ok) {
          try {
            await sidecar.shutdown();
          } catch {
            // Ignore cleanup failure on startup rejection.
          }
          throw enrichStartupError("LibraVDB daemon failed health check", health.message);
        }
        let kernel: GrpcKernelClient | null = null;
        if (cfg.grpcEndpoint) {
          try {
            const secret = loadSecretFromEnv();
            if (
              cfg.grpcEndpointTlsMode !== undefined &&
              !isTlsModeValid(cfg.grpcEndpointTlsMode)
            ) {
              throw new Error(
                `LibraVDB: invalid grpcEndpointTlsMode "${cfg.grpcEndpointTlsMode}" — ` +
                `must be "auto", "tls", or "insecure"`,
              );
            }
            if (
              cfg.grpcEndpointTlsMode === "insecure" &&
              cfg.grpcEndpointTlsCa
            ) {
              // logger is provided by the host and may not have all methods
              logger.warn?.(
                `LibraVDB: grpcEndpointTlsCa is set but grpcEndpointTlsMode ` +
                `is "insecure" — the CA file will not be used`,
              );
            }
            kernel = new GrpcKernelClient({
              endpoint: cfg.grpcEndpoint,
              secret,
              timeoutMs: cfg.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
              tlsCaPath: cfg.grpcEndpointTlsCa,
              tlsMode: cfg.grpcEndpointTlsMode,
            });
          } catch (error) {
            logger.warn?.(`LibraVDB: failed to initialize gRPC kernel client: ${formatError(error)}`);
          }
        }

        return { rpc, sidecar, kernel };
      })().catch((error) => {
        started = null;
        throw enrichStartupError(error);
      });
    }
    return await started;
  };

  return {
    async getRpc() {
      return (await ensureStarted()).rpc;
    },
    async getKernel() {
      return (await ensureStarted()).kernel;
    },
    async emitLifecycleHint(hint: LifecycleHint) {
      try {
        const active = await ensureStarted();
        await active.rpc.call("session_lifecycle_hint", hint);
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
      const active = started;
      started = null;
      const { rpc, sidecar, kernel } = await active;
      try {
        if (kernel) kernel.close();
        await rpc.call("flush", {});
      } finally {
        await sidecar.shutdown();
      }
    },
  };
}

function loadSecretFromEnv(): string | undefined {
  const secret = process.env.LIBRAVDB_AUTH_SECRET;
  if (secret) return secret;
  const path = process.env.LIBRAVDB_AUTH_SECRET_FILE;
  if (path) {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return undefined;
    }
  }
  return undefined;
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
