import { LibravDBClient } from "./libravdb-client.js";
import type { LoggerLike, PluginConfig } from "./types.js";
import { formatError } from "./format-error.js";

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
