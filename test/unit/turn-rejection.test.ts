import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AfterTurnKernelResponse } from "@xdarkicex/libravdb-contracts";
import { buildContextEngineFactory } from "../../src/context-engine.js";
import { manifestStore } from "../../src/manifest.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";

for (const scenario of ["cursorless rejection", "rejection with cursor", "rejected gap repair", "unsafe cursor index", "unsafe cursor version"] as const) {
  test(`commitTurn keeps ${scenario} retryable across engine replacement`, async t => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fsp.mkdtemp(join(tmpdir(), "libravdb-turn-rejection-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    t.after(async () => {
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
      await fsp.rm(stateDir, { recursive: true, force: true });
    });
    const sessionId = randomUUID();
    const messages = [
      { role: "user", content: "Remember this question", id: "user" },
      { role: "assistant", content: "This is the answer", id: "assistant" },
    ];
    const responses = [new AfterTurnKernelResponse({ ok: false,
      ...(scenario === "rejection with cursor" ? { cursor: {
        lastProcessedIndex: 1n, sessionVersion: 1n, manifestTailHash: "reported-tail",
      } } : {}),
    })];
    if (scenario === "unsafe cursor index" || scenario === "unsafe cursor version") {
      responses[0] = new AfterTurnKernelResponse({ ok: true, cursor: {
        lastProcessedIndex: scenario === "unsafe cursor index" ? 9_007_199_254_740_992n : 1n,
        sessionVersion: scenario === "unsafe cursor version" ? 9_007_199_254_740_992n : 1n,
        manifestTailHash: "reported-tail",
      } });
    }
    if (scenario === "rejected gap repair") {
      manifestStore.save(manifestStore.appendACKedMessages(manifestStore.createEmpty(sessionId), [
        { role: "user", content: "old turn", id: "old" },
      ], 0));
      responses.unshift(new AfterTurnKernelResponse({ ok: false, cursor: {
        lastProcessedIndex: -1n, sessionVersion: 0n, manifestTailHash: "",
      } }));
    }
    const calls: Array<{ messages: unknown[] }> = [];
    const client = { async afterTurnKernel(params: { messages: unknown[] }) {
      calls.push(params);
      return responses.shift() ?? new AfterTurnKernelResponse({ ok: true });
    } };
    const runtime: PluginRuntime = { getClient: async () => client as never, onShutdown() {}, async shutdown() {}, async emitLifecycleHint() {} };
    const logger = { info() {}, warn() {}, error() {} };
    const first = buildContextEngineFactory(runtime, { userId: "tester" }, logger);
    const args = { sessionId, messages, advancementKey: randomUUID() };
    try {
      await assert.rejects(first.commitTurn(args), scenario.startsWith("unsafe") ? /invalid session cursor/ : /returned ok=false/);
      assert.equal(manifestStore.load(sessionId).turns.length, 0);
      if (scenario === "rejected gap repair") assert.equal(manifestStore.load(sessionId).recoveryPending, true);
    } finally { await first.dispose(); }

    const next = buildContextEngineFactory(runtime, { userId: "tester" }, logger);
    try {
      assert.equal((await next.commitTurn(args)).status, "committed");
      assert.deepEqual(calls.at(-1)?.messages, messages);
      assert.equal(manifestStore.load(sessionId).turns.length, 2);
      assert.equal(manifestStore.load(sessionId).recoveryPending, undefined);
      assert.equal((await next.commitTurn(args)).status, "duplicate");
      assert.equal(calls.length, scenario === "rejected gap repair" ? 3 : 2);
    } finally { await next.dispose(); }
  });
}
