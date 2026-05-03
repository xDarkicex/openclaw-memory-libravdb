import test from "node:test";
import assert from "node:assert/strict";

import { HealthResponse, RpcRequest, RpcResponse } from "@xdarkicex/libravdb-contracts";
import { RpcClient } from "../../src/rpc.js";
import { computeStartupConnectRetryDelay, resolveEndpoint, startSidecar, type SidecarRuntime } from "../../src/sidecar.js";
import type { PluginConfig, SidecarSocket } from "../../src/types.js";
import { createMemoryLogger } from "../helpers/logger.js";

type CloseHandler = () => void;
type DataHandler = (chunk: Buffer) => void;
type ErrorHandler = (error: Error) => void;

class ControlledSocket implements SidecarSocket {
  private readonly onData = new Set<DataHandler>();
  private readonly onClose = new Set<CloseHandler>();
  private readonly onError = new Set<ErrorHandler>();
  private readonly connectOnce = new Set<CloseHandler>();
  private readonly errorOnce = new Set<ErrorHandler>();
  public autoRespond = true;
  private encoding?: string;

  constructor(public readonly endpoint: string) {
    queueMicrotask(() => {
      for (const handler of this.connectOnce) {
        handler();
      }
      this.connectOnce.clear();
    });
  }

  setEncoding(encoding: string): void {
    this.encoding = encoding;
  }

  on(event: "data" | "close" | "error", handler: DataHandler | CloseHandler | ErrorHandler): void {
    if (event === "data") {
      this.onData.add(handler as DataHandler);
      return;
    }
    if (event === "error") {
      this.onError.add(handler as ErrorHandler);
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

  off(event: "connect" | "error", handler: CloseHandler | ErrorHandler): void {
    if (event === "connect") {
      this.connectOnce.delete(handler as CloseHandler);
      return;
    }
    this.errorOnce.delete(handler as ErrorHandler);
  }

  write(chunk: Buffer | string): void {
    if (!this.autoRespond) {
      return;
    }
    try {
      const requestFrame = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const offset = requestFrame[0] === 0x02 ? 1 : 0;
      const length = requestFrame.readUInt32BE(offset);
      const request = RpcRequest.fromBinary(requestFrame.subarray(offset + 4, offset + 4 + length));
      const result = request.method === "health"
        ? new (HealthResponse as any)({ ok: true, message: this.endpoint }).toBinary()
        : new Uint8Array(0);
      const response = new (RpcResponse as any)({
        id: request.id,
        result,
      });
      const payload = response.toBinary();
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.byteLength, 0);
      const responseFrame = Buffer.concat([header, Buffer.from(payload)]);
      for (const handler of this.onData) {
        // Real Node sockets switch data events to strings once setEncoding is enabled.
        handler(this.encoding ? (responseFrame.toString(this.encoding as BufferEncoding) as unknown as Buffer) : responseFrame);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emitError(err);
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

  emitError(error: Error): void {
    for (const handler of this.onError) {
      handler(error);
    }
    for (const handler of this.errorOnce) {
      handler(error);
    }
    this.errorOnce.clear();
  }
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createRuntime(config: {
  resolve?: (cfg: PluginConfig) => string | Promise<string>;
}) {
  const sockets: ControlledSocket[] = [];
  const endpoints: string[] = [];
  const scheduled: Array<{ delayMs: number; restart: () => void }> = [];

  const runtime: SidecarRuntime = {
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

  return { runtime, sockets, endpoints, scheduled };
}

test("sidecar crash mid-session reconnects within the restart window", async () => {
  const runtime = createRuntime({});
  const logger = createMemoryLogger();
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

test("sidecar runtime socket errors reject pending RPCs and recover after restart", async () => {
  const runtime = createRuntime({});
  const logger = createMemoryLogger();
  const handle = await startSidecar({ rpcTimeoutMs: 50, maxRetries: 2 }, logger, runtime.runtime);
  const rpc = new RpcClient(handle.socket, { timeoutMs: 50 });

  runtime.sockets[0]!.autoRespond = false;
  const pending = rpc.call("health", {});
  runtime.sockets[0]!.emitError(new Error("ECONNRESET"));
  await assert.rejects(pending, /ECONNRESET/);

  runtime.sockets[0]!.emitClose();
  await flushAsyncWork();
  assert.equal(runtime.scheduled.length, 1);

  runtime.scheduled[0]!.restart();
  await flushAsyncWork();

  await assert.doesNotReject(() => rpc.call("health", {}));
  assert.equal(handle.isDegraded(), false);
});

test("sidecar enters degraded mode after exhausting retry budget", async () => {
  const runtime = createRuntime({});
  const logger = createMemoryLogger();
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
  const logger = createMemoryLogger();
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

test("missing daemon errors point users at libravdbd instead of spawn internals", async () => {
  const runtime = createRuntime({
    resolve: () => "unix:/tmp/libravdb.sock",
  });
  runtime.runtime.createSocket = () => ({
    setEncoding() {},
    on() {},
    once(event, handler) {
      if (event === "error") {
        queueMicrotask(() => (handler as (error: Error) => void)(Object.assign(new Error("missing"), { code: "ENOENT" })));
      }
    },
    off() {},
    write() {},
    destroy() {},
  });

  await assert.rejects(
    () => startSidecar({ rpcTimeoutMs: 50 }, createMemoryLogger(), runtime.runtime),
    /install and start libravdbd separately/i,
  );
});

test("startup connect retries ENOENT until the daemon becomes available", async () => {
  const runtime = createRuntime({});
  const logger = createMemoryLogger();
  let remainingFailures = 2;

  runtime.runtime.createSocket = (endpoint) => {
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      return {
        setEncoding() {},
        on() {},
        once(event, handler) {
          if (event === "error") {
            queueMicrotask(() => (handler as (error: Error) => void)(Object.assign(new Error("missing"), { code: "ENOENT" })));
          }
        },
        off() {},
        write() {},
        destroy() {},
      };
    }

    const socket = new ControlledSocket(endpoint);
    runtime.sockets.push(socket);
    return socket;
  };

  const start = Date.now();
  const handle = await startSidecar({ rpcTimeoutMs: 50, maxRetries: 2 }, logger, runtime.runtime);
  const elapsedMs = Date.now() - start;

  assert.equal(runtime.sockets.length, 1);
  assert.equal(handle.isDegraded(), false);
  assert.ok(
    logger.infos.filter((message) => message.includes("Daemon not ready, retrying connection")).length === 2,
  );
  assert.deepEqual(
    logger.infos.filter((message) => message.includes("Daemon not ready, retrying connection")),
    [
      "[libravdb] Daemon not ready, retrying connection (attempt 1/5)...",
      "[libravdb] Daemon not ready, retrying connection (attempt 2/5)...",
    ],
  );
  assert.ok(
    elapsedMs >= computeStartupConnectRetryDelay(0) + computeStartupConnectRetryDelay(1),
    `expected retries to wait at least 300ms, got ${elapsedMs}ms`,
  );
});
