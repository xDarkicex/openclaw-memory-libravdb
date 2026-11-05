import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildContextEngineFactory, FLUSH_ASYNC_INGESTION } from "../../src/context-engine.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";

test("distinct host message IDs preserve a repeated exchange across engine replacement", async t => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const stateDir = await fsp.mkdtemp(join(tmpdir(), "libravdb-message-identity-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  t.after(async () => {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await fsp.rm(stateDir, { recursive: true, force: true });
  });
  const calls: Array<{ messages: Array<{ id: string }>; cursor?: { lastProcessedIndex: number } }> = [];
  let stored = 0;
  const client = { async afterTurnKernel(params: typeof calls[number]) {
    calls.push(params);
    stored += params.messages.length;
    return { ok: true, cursor: { lastProcessedIndex: stored - 1, sessionVersion: calls.length, manifestTailHash: `daemon-${stored}` } };
  } };
  const runtime: PluginRuntime = { getClient: async () => client as never, onShutdown() {}, async shutdown() {}, async emitLifecycleHint() {} };
  const logger = { info() {}, warn() {}, error() {} };
  const sessionId = randomUUID();
  const first = buildContextEngineFactory(runtime, { userId: "tester" }, logger);
  const exchange = (suffix: string) => [
    { role: "user", content: "ping", id: `user-${suffix}` },
    { role: "assistant", content: "pong", id: `assistant-${suffix}` },
  ];
  await first.commitTurn({ advancementKey: randomUUID(), sessionId, messages: exchange("one") });
  await first.dispose();
  const next = buildContextEngineFactory(runtime, { userId: "tester" }, logger);
  try {
    await next.commitTurn({ advancementKey: randomUUID(), sessionId, messages: exchange("two") });
    assert.equal(calls.length, 2, "the second exchange must reach the daemon despite identical text");
    assert.deepEqual(calls[1].messages.map(message => message.id), ["user-two", "assistant-two"]);
    assert.equal(calls[1].cursor?.lastProcessedIndex, 1);
    const replay = await next.afterTurn({ sessionId, messages: exchange("two") });
    await next[FLUSH_ASYNC_INGESTION]();
    assert.equal(replay.skipped, true);
    assert.equal(calls.length, 2, "an exact message-identity replay still skips ingestion");
  } finally { await next.dispose(); }
});
