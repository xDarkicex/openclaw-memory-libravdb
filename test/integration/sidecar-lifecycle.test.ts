import test from "node:test";
import assert from "node:assert/strict";

import { RpcClient } from "../../src/rpc.js";
import { installSidecarProcessCleanup, resolveEndpoint, startSidecar, type SidecarRuntime } from "../../src/sidecar.js";
import type { LoggerLike, PluginConfig, SidecarSocket } from "../../src/types.js";

type CloseHandler = () => void;
type DataHandler = (chunk: string) => void;
type ErrorHandler = (error: Error) => void;

class ControlledSocket implements SidecarSocket {
  private readonly onData = new Set<DataHandler>();
  private readonly onClose = new Set<CloseHandler>();
  private readonly connectOnce = new Set<CloseHandler>();
  private readonly errorOnce = new Set<ErrorHandler>();

  constructor(public readonly endpoint: string) {
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
      const msg = JSON.parse(chunk) as { id: number; method: string };
      const response = JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: msg.method === "health" ? { ok: true, endpoint: this.endpoint } : {},
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
    this.emitClose();
  }

  emitClose(): void {
    for (const handler of this.onClose) {
      handler();
    }
  }
}

function createLogger(): LoggerLike & { infos: string[]; errors: string[] } {
  return {
    infos: [],
    errors: [],
    info(message: string) {
      this.infos.push(message);
    },
    error(message: string) {
      this.errors.push(message);
    },
  };
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createRuntime(config: {
  resolve?: (cfg: PluginConfig) => string | Promise<string>;
}) {
  const sockets: ControlledSocket[] = [];
  const endpoints: string[] = [];
  const environments: Array<Record<string, string>> = [];
  const scheduled: Array<{ delayMs: number; restart: () => void }> = [];

  const runtime: SidecarRuntime = {
    prepareLaunch(_cfg, env) {
      environments.push({ ...env });
    },
    resolveEndpoint: config.resolve ?? ((cfg) => resolveEndpoint(cfg)),
    createSocket(endpoint: string) {
      endpoints.push(endpoint);
      const socket = new ControlledSocket(endpoint);
      sockets.push(socket);
      return socket;
    },
    scheduleRestart(delayMs: number, restart: () => void) {
      scheduled.push({ delayMs, restart });
    },
  };

  return { runtime, sockets, endpoints, environments, scheduled };
}

test("sidecar crash mid-session reconnects within the restart window", async () => {
  const runtime = createRuntime({});
  const logger = createLogger();
  const handle = await startSidecar({ rpcTimeoutMs: 50, maxRetries: 2 }, logger, runtime.runtime);
  const rpc = new RpcClient(handle.socket, { timeoutMs: 50 });

  await assert.doesNotReject(() => rpc.call("health", {}));

  runtime.sockets[0]?.emitClose();
  await flushAsyncWork();

  assert.equal(runtime.scheduled.length, 1);
  assert.equal(runtime.scheduled[0]?.delayMs, 500);

  runtime.scheduled[0]?.restart();
  await flushAsyncWork();

  assert.equal(runtime.sockets.length, 2);
  await assert.doesNotReject(() => rpc.call("health", {}));
  assert.equal(handle.isDegraded(), false);
});

test("sidecar enters degraded mode after exhausting retry budget", async () => {
  const runtime = createRuntime({});
  const logger = createLogger();
  const handle = await startSidecar({ rpcTimeoutMs: 50, maxRetries: 1 }, logger, runtime.runtime);

  runtime.sockets[0]?.emitClose();
  await flushAsyncWork();
  assert.equal(runtime.scheduled.length, 1);

  runtime.scheduled[0]?.restart();
  await flushAsyncWork();
  runtime.sockets[1]?.emitClose();
  await flushAsyncWork();

  assert.equal(handle.isDegraded(), true);
  assert.ok(logger.errors.some((message) => message.includes("degraded mode")));
});

test("windows tcp fallback path starts and serves RPC traffic end to end", async () => {
  const runtime = createRuntime({});
  const logger = createLogger();
  const handle = await startSidecar(
    { rpcTimeoutMs: 50, sidecarPath: "tcp:127.0.0.1:7777" },
    logger,
    runtime.runtime,
  );
  const rpc = new RpcClient(handle.socket, { timeoutMs: 50 });

  const health = await rpc.call<{ ok: boolean; endpoint: string }>("health", {});

  assert.equal(health.ok, true);
  assert.equal(runtime.endpoints[0], "tcp:127.0.0.1:7777");
  assert.ok(logger.infos.some((message) => message.includes("TCP endpoint tcp:127.0.0.1:7777")));
  assert.equal(handle.isDegraded(), false);
});

test("sidecar startup forwards embedding config into launch environment", async () => {
  const runtime = createRuntime({});
  const logger = createLogger();

  await startSidecar(
    {
      rpcTimeoutMs: 50,
      dbPath: "/tmp/libravdb",
      embeddingRuntimePath: "/opt/onnx/libonnxruntime.so",
      embeddingBackend: "onnx-local",
      embeddingProfile: "nomic-embed-text-v1.5",
      fallbackProfile: "all-minilm-l6-v2",
      embeddingModelPath: "/models/minilm.onnx",
      embeddingTokenizerPath: "/models/tokenizer.json",
      embeddingDimensions: 384,
      embeddingNormalize: true,
    },
    logger,
    runtime.runtime,
  );

  assert.deepEqual(runtime.environments[0], {
    LIBRAVDB_DB_PATH: "/tmp/libravdb",
    LIBRAVDB_ONNX_RUNTIME: "/opt/onnx/libonnxruntime.so",
    LIBRAVDB_EMBEDDING_BACKEND: "onnx-local",
    LIBRAVDB_EMBEDDING_PROFILE: "nomic-embed-text-v1.5",
    LIBRAVDB_FALLBACK_PROFILE: "all-minilm-l6-v2",
    LIBRAVDB_EMBEDDING_MODEL: "/models/minilm.onnx",
    LIBRAVDB_EMBEDDING_TOKENIZER: "/models/tokenizer.json",
    LIBRAVDB_EMBEDDING_DIMENSIONS: "384",
    LIBRAVDB_EMBEDDING_NORMALIZE: "true",
  });
});

test("process cleanup hooks stop the owned sidecar on host exit signals", () => {
  const handlers = new Map<string, Set<() => void>>();
  const host = {
    once(event: string, handler: () => void) {
      const set = handlers.get(event) ?? new Set<() => void>();
      set.add(handler);
      handlers.set(event, set);
    },
    off(event: string, handler: () => void) {
      handlers.get(event)?.delete(handler);
    },
  };

  let stops = 0;
  const remove = installSidecarProcessCleanup(host, () => {
    stops += 1;
  });

  for (const event of ["exit", "SIGINT", "SIGTERM", "SIGHUP"]) {
    const registered = handlers.get(event);
    assert.equal(registered?.size, 1);
    registered?.forEach((handler) => handler());
  }
  assert.equal(stops, 1);

  remove();
  for (const event of ["exit", "SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(handlers.get(event)?.size ?? 0, 0);
  }
});
