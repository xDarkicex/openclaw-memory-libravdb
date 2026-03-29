import { RpcClient } from "./rpc.js";
import { startSidecar } from "./sidecar.js";
import type { LoggerLike, PluginConfig, SidecarHandle } from "./types.js";

export type RpcGetter = () => Promise<RpcClient>;
export const DEFAULT_RPC_TIMEOUT_MS = 30000;

export interface PluginRuntime {
  getRpc: RpcGetter;
  shutdown(): Promise<void>;
}

export function createPluginRuntime(
  cfg: PluginConfig,
  logger: LoggerLike = console,
): PluginRuntime {
  let started: Promise<{ rpc: RpcClient; sidecar: SidecarHandle }> | null = null;
  let stopped = false;

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
        const health = await rpc.call<{ ok?: boolean }>("health", {});
        if (!health.ok) {
          try {
            await sidecar.shutdown();
          } catch {
            // Ignore cleanup failure on startup rejection.
          }
          throw new Error("LibraVDB sidecar failed health check");
        }
        return { rpc, sidecar };
      })().catch((error) => {
        started = null;
        throw error;
      });
    }
    return await started;
  };

  return {
    async getRpc() {
      return (await ensureStarted()).rpc;
    },
    async shutdown() {
      stopped = true;
      if (!started) {
        return;
      }
      const active = started;
      started = null;
      const { rpc, sidecar } = await active;
      try {
        await rpc.call("flush", {});
      } finally {
        await sidecar.shutdown();
      }
    },
  };
}
