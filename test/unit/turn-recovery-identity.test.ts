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

for (const prePromptMessageCount of [0, 2]) {
  test(`an idless recovered turn stays idempotent after module reload (pre-prompt ${prePromptMessageCount})`, async t => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fsp.mkdtemp(join(tmpdir(), "libravdb-recovery-identity-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    t.after(async () => {
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
      await fsp.rm(stateDir, { recursive: true, force: true });
    });
    const sessionId = randomUUID();
    const messages = [
      ...(prePromptMessageCount ? [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
      ] : []),
      { role: "user", content: "New question without a host ID" },
    ];
    manifestStore.save(manifestStore.appendACKedMessages(manifestStore.createEmpty(sessionId), [
      { role: "user", content: "Old daemon data", id: "old" },
    ], 0));
    let calls = 0;
    const client = { async afterTurnKernel() {
      calls++;
      return new AfterTurnKernelResponse({ ok: calls !== 1, cursor: {
        lastProcessedIndex: calls === 1 ? -1n : BigInt(messages.length - 1),
        sessionVersion: 1n, manifestTailHash: calls === 1 ? "" : "recovered",
      } });
    } };
    const runtime: PluginRuntime = { getClient: async () => client as never, onShutdown() {}, async shutdown() {}, async emitLifecycleHint() {} };
    const logger = { info() {}, warn() {}, error() {} };
    const args = { sessionId, messages, prePromptMessageCount, advancementKey: randomUUID() };
    const first = buildContextEngineFactory(runtime, { userId: "tester" }, logger);
    try {
      assert.equal((await first.commitTurn(args)).status, "committed");
      assert.equal(calls, 2, "the first commit repairs a cursor gap");
      assert.equal(manifestStore.load(sessionId).recoveryPending, undefined);
    } finally { await first.dispose(); }

    // A fresh module has no committed-key memo, as after a process restart.
    const moduleUrl = new URL("../../src/context-engine.js", import.meta.url);
    moduleUrl.search = randomUUID();
    const freshModule: typeof import("../../src/context-engine.js") = await import(moduleUrl.href);
    const next = freshModule.buildContextEngineFactory(runtime, { userId: "tester" }, logger);
    try {
      await next.commitTurn(args);
      assert.equal(calls, 2, "the persisted recovery checkpoint must suppress an exact replay");
      assert.equal(manifestStore.load(sessionId).turns.length, messages.length);
    } finally { await next.dispose(); }
  });
}
