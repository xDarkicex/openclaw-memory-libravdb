import test from "node:test";
import assert from "node:assert/strict";

import {
  daemonProvisioningHint,
  buildSidecarEnv,
  computeBackoffMs,
  defaultEndpoint,
  isTcpEndpoint,
  resolveConfiguredEndpoint,
  resolveEndpoint,
  startSidecar,
  type SidecarRuntime,
} from "../../src/sidecar.js";
import type { SidecarSocket } from "../../src/types.js";

test("resolveEndpoint strips unix prefix and keeps tcp endpoints", () => {
  assert.equal(resolveEndpoint({ rpcTimeoutMs: 1, sidecarPath: "unix:/tmp/x.sock" }), "/tmp/x.sock");
  assert.equal(resolveEndpoint({ rpcTimeoutMs: 1, sidecarPath: "tcp:127.0.0.1:7777" }), "tcp:127.0.0.1:7777");
});

test("resolveConfiguredEndpoint defaults to a stable platform endpoint", () => {
  assert.equal(resolveConfiguredEndpoint({ rpcTimeoutMs: 1 }), defaultEndpoint());
});

test("resolveConfiguredEndpoint rejects executable paths", () => {
  assert.throws(
    () => resolveConfiguredEndpoint({ rpcTimeoutMs: 1, sidecarPath: "/tmp/libravdbd" }),
    /Executable paths are no longer supported/,
  );
});

test("resolveConfiguredEndpoint rejects malformed daemon endpoints", () => {
  for (const sidecarPath of ["unix:", "tcp:", "tcp::123", "tcp:127.0.0.1", "tcp:127.0.0.1:notaport", "tcp:127.0.0.1:70000"]) {
    assert.throws(
      () => resolveConfiguredEndpoint({ rpcTimeoutMs: 1, sidecarPath }),
      /must be a daemon endpoint/,
      sidecarPath,
    );
  }
});

test("resolveConfiguredEndpoint normalizes incidental Unix path whitespace", () => {
  assert.equal(
    resolveConfiguredEndpoint({ rpcTimeoutMs: 1, sidecarPath: " unix: /tmp/libravdb.sock " }),
    "unix:/tmp/libravdb.sock",
  );
  assert.equal(
    resolveEndpoint({ rpcTimeoutMs: 1, sidecarPath: " unix: /tmp/libravdb.sock " }),
    "/tmp/libravdb.sock",
  );
});

test("defaultEndpoint uses unix sockets on unix and localhost TCP on windows", () => {
  // On machines where /opt/homebrew/var/libravdbd/run/libravdb.sock exists (Homebrew install),
  // defaultEndpoint probes the filesystem and returns the Homebrew path. On machines without
  // it, the user-local fallback (~/.libravdbd/run/libravdb.sock) is used. Both are valid unix
  // endpoints — the test verifies the platform dispatch (unix vs win32) and env-var override.
  const darwinResult = defaultEndpoint("darwin", "/Users/demo");
  assert.match(darwinResult, /^unix:.*libravdb\.sock$/);
  assert.equal(defaultEndpoint("win32", "C:\\Users\\demo"), "tcp:127.0.0.1:37421");

  // Env var override takes precedence when set.
  const savedEnv = process.env.LIBRAVDB_RPC_ENDPOINT;
  try {
    process.env.LIBRAVDB_RPC_ENDPOINT = "unix: /custom/path/libravdb.sock ";
    assert.equal(defaultEndpoint("darwin", "/Users/demo"), "unix:/custom/path/libravdb.sock");
    process.env.LIBRAVDB_RPC_ENDPOINT = "tcp:10.0.0.1:9999";
    assert.equal(defaultEndpoint("darwin", "/Users/demo"), "tcp:10.0.0.1:9999");
  } finally {
    if (savedEnv === undefined) {
      delete process.env.LIBRAVDB_RPC_ENDPOINT;
    } else {
      process.env.LIBRAVDB_RPC_ENDPOINT = savedEnv;
    }
  }
});

test("defaultEndpoint prefers the Homebrew socket when the user-local socket is absent", () => {
  const endpoint = defaultEndpoint(
    "darwin",
    "/Users/demo",
    (candidate) => candidate === "/opt/homebrew/var/libravdbd/run/libravdb.sock",
  );

  assert.equal(endpoint, "unix:/opt/homebrew/var/libravdbd/run/libravdb.sock");
});

test("computeBackoffMs applies capped exponential backoff", () => {
  assert.equal(computeBackoffMs(0), 500);
  assert.equal(computeBackoffMs(1), 1000);
  assert.equal(computeBackoffMs(10), 16000);
});

test("isTcpEndpoint detects tcp endpoints", () => {
  assert.equal(isTcpEndpoint("tcp:127.0.0.1:7777"), true);
  assert.equal(isTcpEndpoint("/tmp/x.sock"), false);
});

test("buildSidecarEnv maps embedding config into sidecar environment", () => {
  const env = buildSidecarEnv({
    rpcTimeoutMs: 1,
    dbPath: "/tmp/libravdb",
    embeddingRuntimePath: "/opt/onnx/libonnxruntime.so",
    onnxDevice: "cpu",
    embeddingBackend: "custom-local",
    embeddingProfile: "nomic-embed-text-v1.5",
    fallbackProfile: "all-minilm-l6-v2",
    embeddingModelPath: "/models/custom.onnx",
    embeddingTokenizerPath: "/models/tokenizer.json",
    embeddingDimensions: 768,
    embeddingNormalize: false,
    lifecycleJournalMaxEntries: 250,
  });

  assert.deepEqual(env, {
    LIBRAVDB_DB_PATH: "/tmp/libravdb",
    LIBRAVDB_ONNX_RUNTIME: "/opt/onnx/libonnxruntime.so",
    LIBRAVDB_ONNX_DEVICE: "cpu",
    LIBRAVDB_EMBEDDING_BACKEND: "custom-local",
    LIBRAVDB_EMBEDDING_PROFILE: "nomic-embed-text-v1.5",
    LIBRAVDB_FALLBACK_PROFILE: "all-minilm-l6-v2",
    LIBRAVDB_EMBEDDING_MODEL: "/models/custom.onnx",
    LIBRAVDB_EMBEDDING_TOKENIZER: "/models/tokenizer.json",
    LIBRAVDB_EMBEDDING_DIMENSIONS: "768",
    LIBRAVDB_EMBEDDING_NORMALIZE: "false",
    LIBRAVDB_LIFECYCLE_JOURNAL_MAX_ENTRIES: "250",
  });
});

test("buildSidecarEnv defaults onnxDevice to cpu when not configured", () => {
  const env = buildSidecarEnv({
    rpcTimeoutMs: 1,
    dbPath: "/tmp/libravdb",
  });

  assert.equal(env.LIBRAVDB_ONNX_DEVICE, "cpu");
});

test("daemonProvisioningHint explains the npm vs Homebrew split", () => {
  assert.match(daemonProvisioningHint(), /npm package/);
  assert.match(daemonProvisioningHint(), /install and start libravdbd separately/);
});

type UnitCloseHandler = () => void;
type UnitDataHandler = (chunk: Buffer) => void;
type UnitErrorHandler = (error: Error) => void;

class ManualSidecarSocket implements SidecarSocket {
  private readonly onData = new Set<UnitDataHandler>();
  private readonly onClose = new Set<UnitCloseHandler>();
  private readonly onError = new Set<UnitErrorHandler>();
  private readonly connectOnce = new Set<UnitCloseHandler>();
  private readonly errorOnce = new Set<UnitErrorHandler>();

  constructor(readonly endpoint: string) {
    queueMicrotask(() => this.emitConnect());
  }

  setEncoding(_encoding: string): void {}

  on(event: "data" | "close" | "error", handler: UnitDataHandler | UnitCloseHandler | UnitErrorHandler): void {
    if (event === "data") {
      this.onData.add(handler as UnitDataHandler);
      return;
    }
    if (event === "error") {
      this.onError.add(handler as UnitErrorHandler);
      return;
    }
    this.onClose.add(handler as UnitCloseHandler);
  }

  once(event: "connect" | "error", handler: UnitCloseHandler | UnitErrorHandler): void {
    if (event === "connect") {
      this.connectOnce.add(handler as UnitCloseHandler);
      return;
    }
    this.errorOnce.add(handler as UnitErrorHandler);
  }

  off(event: "connect" | "error", handler: UnitCloseHandler | UnitErrorHandler): void {
    if (event === "connect") {
      this.connectOnce.delete(handler as UnitCloseHandler);
      return;
    }
    this.errorOnce.delete(handler as UnitErrorHandler);
  }

  write(_chunk: Buffer | string): void {}

  destroy(_err?: Error): void {
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

  private emitConnect(): void {
    for (const handler of this.connectOnce) {
      handler();
    }
    this.connectOnce.clear();
  }
}

function createManualRestartRuntime() {
  const sockets: ManualSidecarSocket[] = [];
  const scheduled: Array<{ delayMs: number; restart: () => void }> = [];

  const runtime: SidecarRuntime = {
    resolveEndpoint: () => "unix:/tmp/libravdb.sock",
    createSocket(endpoint) {
      const socket = new ManualSidecarSocket(endpoint);
      sockets.push(socket);
      return socket;
    },
    scheduleRestart(delayMs, restart) {
      scheduled.push({ delayMs, restart });
    },
  };

  return { runtime, sockets, scheduled };
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("sidecar retry budget resets after stability window", async () => {
  const runtime = createManualRestartRuntime();
  runtime.runtime.stabilityWindowMs = 0;
  const logger = { error() {}, info() {}, warn() {} };
  const handle = await startSidecar({ rpcTimeoutMs: 50, maxRetries: 1 }, logger, runtime.runtime);

  // First outage: crash schedules reconnect.
  runtime.sockets[0]?.emitClose();
  await flushAsyncWork();
  assert.equal(runtime.scheduled.length, 1);

  // Reconnect succeeds, stability window fires (windowMs=0 resets synchronously).
  runtime.scheduled[0]?.restart();
  await flushAsyncWork();
  assert.equal(runtime.sockets.length, 2);

  // Second outage: budget was reset, crash does NOT degrade.
  runtime.sockets[1]?.emitClose();
  await flushAsyncWork();

  assert.equal(handle.isDegraded(), false);
  assert.equal(runtime.scheduled.length, 2);
});

test("crash before stability window preserves retry count and triggers degraded mode", async () => {
  const runtime = createManualRestartRuntime();
  runtime.runtime.stabilityWindowMs = 60_000;
  const logger = { error() {}, info() {}, warn() {} };
  const handle = await startSidecar({ rpcTimeoutMs: 50, maxRetries: 1 }, logger, runtime.runtime);

  // First crash schedules reconnect.
  runtime.sockets[0]?.emitClose();
  await flushAsyncWork();
  assert.equal(runtime.scheduled.length, 1);

  // Reconnect succeeds, stability timer starts but window is 60s away.
  runtime.scheduled[0]?.restart();
  await flushAsyncWork();
  assert.equal(runtime.sockets.length, 2);

  // Second crash before stability window — retries still 1, triggers degraded.
  runtime.sockets[1]?.emitClose();
  await flushAsyncWork();

  assert.equal(handle.isDegraded(), true);
});

test("stability window with non-zero delay resets retry budget after timer fires", async () => {
  const runtime = createManualRestartRuntime();
  runtime.runtime.stabilityWindowMs = 10;
  const logger = { error() {}, info() {}, warn() {} };
  const handle = await startSidecar({ rpcTimeoutMs: 50, maxRetries: 1 }, logger, runtime.runtime);

  // First outage: crash schedules reconnect.
  runtime.sockets[0]?.emitClose();
  await flushAsyncWork();
  assert.equal(runtime.scheduled.length, 1);

  // Reconnect succeeds, stability timer starts with 10ms window.
  runtime.scheduled[0]?.restart();
  await flushAsyncWork();

  // Wait for the timer to fire (10ms window + buffer).
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Second outage: budget was reset by the timer, crash does NOT degrade.
  runtime.sockets[1]?.emitClose();
  await flushAsyncWork();

  assert.equal(handle.isDegraded(), false);
  assert.equal(runtime.scheduled.length, 2);
});
