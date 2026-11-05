import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildContextEngineFactory } from "../../src/context-engine.js";
import { manifestStore } from "../../src/manifest.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";

for (const cursorAck of [false, true]) {
  for (const recoverGap of [false, true]) {
    test(`a truncated message's exact replay is durable across module reload (cursor ACK: ${cursorAck}, gap recovery: ${recoverGap})`, async t => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      const stateDir = await fsp.mkdtemp(join(tmpdir(), "libravdb-bounded-replay-"));
      process.env.OPENCLAW_STATE_DIR = stateDir;
      t.after(async () => {
        if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
        else process.env.OPENCLAW_STATE_DIR = previousStateDir;
        await fsp.rm(stateDir, { recursive: true, force: true });
      });
      const sent: Array<Array<{ id: string; role: string; content: string }>> = [];
      const client = { async afterTurnKernel(p: { messages: typeof sent[number] }) {
        sent.push(p.messages);
        if (recoverGap && sent.length === 1) return { ok: true, cursor: { lastProcessedIndex: -1, sessionVersion: 0, manifestTailHash: "" } };
        return { ok: true, ...(cursorAck ? { cursor: {
          lastProcessedIndex: sent.length - 1 - Number(recoverGap), sessionVersion: sent.length, manifestTailHash: "acknowledged",
        } } : {}) };
      } };
      const runtime: PluginRuntime = { getClient: async () => client as never, onShutdown() {}, async shutdown() {}, async emitLifecycleHint() {} };
      const logger = { info() {}, warn() {}, error() {} };
      const original = { id: "host-message-1", role: "assistant", content: "original prefix " + "large response ".repeat(2000) };
      const args = { sessionId: randomUUID(), messages: [original], advancementKey: randomUUID() };
      const expectedCalls = recoverGap ? 2 : 1;
      if (recoverGap) manifestStore.save(manifestStore.appendACKedMessages(manifestStore.createEmpty(args.sessionId), [
        { id: "old", role: "user", content: "old daemon state" },
      ], 0));
      const first = buildContextEngineFactory(runtime, { userId: "tester" }, logger);
      try { await first.commitTurn(args); } finally { await first.dispose(); }
      assert.equal(sent.length, expectedCalls);
      assert.ok(sent[0]![0]!.content.length < original.content.length, "the embedding safety cap remains enforced");
      const stored = manifestStore.load(args.sessionId);
      assert.equal(stored.turns[0]!.contentHash, manifestStore.hashString(sent[0]![0]!.content), "the daemon chain hashes the actual bounded payload");
      assert.ok(manifestStore.verifyChain(stored));
      assert.deepEqual(Object.keys(sent[0]![0]!).sort(), ["content", "id", "role"], "checkpoint metadata stays out of RPC messages");

      const moduleUrl = new URL("../../src/context-engine.js", import.meta.url);
      moduleUrl.search = randomUUID();
      const freshModule: typeof import("../../src/context-engine.js") = await import(moduleUrl.href);
      const next = freshModule.buildContextEngineFactory(runtime, { userId: "tester" }, logger);
      try {
        await next.commitTurn(args);
        assert.equal(sent.length, expectedCalls, "an exact host replay must not ingest the truncated message twice");
        await next.commitTurn({ ...args, advancementKey: randomUUID(), messages: [{ ...original, content: "changed prefix " + original.content.slice(16) }] });
        assert.equal(sent.length, expectedCalls + 1, "changed source content remains new even when its forwarded tail is identical");
        assert.equal(sent[0]![0]!.content, sent.at(-1)![0]!.content);
      } finally { await next.dispose(); }
    });
  }
}
