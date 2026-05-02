import test from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { RpcClient } from "../../src/rpc.js";
import { buildContextEngineFactory } from "../../src/context-engine.js";
import { createRecallCache } from "../../src/recall-cache.js";
import { acquireTestDaemonHandle, type TestDaemonHandle } from "./daemon-harness.js";
import type { PluginConfig, SearchResult, SidecarSocket } from "../../src/types.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";

// ---------------------------------------------------------------------------
// Polling helper: daemon indexing is async, so retry searches until results
// appear or the deadline expires.
// ---------------------------------------------------------------------------
async function pollForResults(
  rpc: RpcClient,
  collection: string,
  text: string,
  k: number,
  maxAttempts = 10,
  delayMs = 500,
): Promise<SearchResult[]> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await rpc.call<{ results: SearchResult[] }>("search_text", {
      collection,
      text,
      k,
    });
    if (result.results.length > 0) return result.results;
    if (i < maxAttempts - 1) await sleep(delayMs);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Connect a raw Node TCP/unix socket to the daemon endpoint and wrap it in
// the SidecarSocket interface expected by RpcClient.
// ---------------------------------------------------------------------------
function connectToDaemon(endpoint: string): SidecarSocket {
  const isTcp = endpoint.startsWith("tcp:");
  const isUnix = endpoint.startsWith("unix:");
  if (!isTcp && !isUnix) {
    throw new Error(
      `Unsupported daemon endpoint "${endpoint}". ` +
      `Expected "tcp:<host>:<port>" or "unix:<path>".`,
    );
  }
  const target = isTcp ? endpoint.slice(4) : endpoint.slice(5);

  const [host, portStr] = isTcp ? target.split(":") : [null, null];
  const port = portStr ? parseInt(portStr, 10) : undefined;

  const raw = createConnection(
    isTcp ? { host: host!, port: port! } : { path: target },
  );

  const socket: SidecarSocket = {
    setEncoding(_encoding: string) {},
    on(event: string, handler: (...args: unknown[]) => void) {
      raw.on(event, handler as (...args: unknown[]) => void);
    },
    once(event: string, handler: (...args: unknown[]) => void) {
      raw.once(event, handler as (...args: unknown[]) => void);
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      raw.off(event, handler as (...args: unknown[]) => void);
    },
    write(chunk: Buffer | string) {
      raw.write(chunk);
    },
    destroy(err?: Error) {
      raw.destroy(err);
    },
  } as SidecarSocket;

  return socket;
}

function buildRuntime(rpc: RpcClient): PluginRuntime {
  return {
    getRpc: async () => rpc,
    getKernel: () => null,
    emitLifecycleHint: async () => {},
    shutdown: async () => {},
  };
}

// ---------------------------------------------------------------------------
// End-to-end smoke test: plant marker → search → cross-session recall
//
// Requires a running libravdbd (built Go sidecar).  In CI set
// LIBRAVDB_TEST_DAEMON_BINARY or LIBRAVDBD_SOURCE_DIR.  Locally an existing
// daemon can be used via LIBRAVDB_TEST_SIDECAR_PATH.
// ---------------------------------------------------------------------------
test("cross-session durable memory smoke test", { skip: !process.env.CI && !process.env.LIBRAVDB_TEST_SIDECAR_PATH && !process.env.LIBRAVDB_TEST_DAEMON_BINARY && !process.env.LIBRAVDBD_SOURCE_DIR ? "set LIBRAVDB_TEST_SIDECAR_PATH or LIBRAVDB_TEST_DAEMON_BINARY to run" : false }, async () => {
  let daemon: TestDaemonHandle | null = null;
  let rpc: RpcClient | null = null;

  try {
    daemon = await acquireTestDaemonHandle();
    const socket = connectToDaemon(daemon.endpoint);

    rpc = new RpcClient(socket, { timeoutMs: 30_000 });

    const marker = `SMOKE_MARKER_${randomUUID()}`;
    const userId = "smoke-test-user";
    const cfg: PluginConfig = { userId };

    const engine = buildContextEngineFactory(
      buildRuntime(rpc),
      cfg,
      createRecallCache<SearchResult>(),
    );

    // --- Session A: ingest the marker ---
    const sessionA = "smoke-session-a-" + randomUUID().slice(0, 8);
    await engine.bootstrap({ sessionId: sessionA, sessionKey: "sk-a" });
    await engine.ingest({
      sessionId: sessionA,
      sessionKey: "sk-a",
      message: { role: "user", content: `Please remember this: ${marker}` },
    });
    await engine.afterTurn({
      sessionId: sessionA,
      sessionKey: "sk-a",
      messages: [
        { role: "user", content: `Please remember this: ${marker}` },
        { role: "assistant", content: `I'll remember: ${marker}` },
      ],
    });

    // --- Verify Session A can search its own marker (poll: indexing is async) ---
    const resultsA = await pollForResults(rpc, `user:${userId}`, marker, 5);
    assert.ok(resultsA.length > 0, "marker should be searchable after ingest in session A");
    const foundA = resultsA.some(
      (r) => r.text.includes(marker) || r.text.includes("remember this"),
    );
    assert.ok(foundA, "marker content should appear in session A search results");

    // --- Session B: cross-session recall ---
    const sessionB = "smoke-session-b-" + randomUUID().slice(0, 8);
    await engine.bootstrap({ sessionId: sessionB, sessionKey: "sk-b" });

    // Assemble context for session B — this simulates what OpenClaw does
    // when building the system prompt for a new session.
    const assembled = await engine.assemble({
      sessionId: sessionB,
      sessionKey: "sk-b",
      messages: [{ role: "user", content: "what do you remember about the smoke marker?" }],
      tokenBudget: 8000,
      prompt: "recall anything about smoke markers",
    });

    // Verify marker is still searchable from session B (cross-session recall)
    const resultsB = await pollForResults(rpc, `user:${userId}`, marker, 5);
    assert.ok(resultsB.length > 0, "marker should be searchable from session B (cross-session recall)");
    const foundB = resultsB.some(
      (r) => r.text.includes(marker) || r.text.includes("remember this"),
    );
    assert.ok(foundB, "marker should be recallable across sessions under the same userId");
  } finally {
    await rpc?.call("flush_namespace", { namespace: "smoke-test-user" }).catch(() => {});
    rpc = null;
    await daemon?.stop();
  }
});
