import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildContextEngineFactory } from "../../src/context-engine.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";

for (const blockedRead of ["continuity", "user", "persona", undefined]) {
  test(blockedRead ? `an established conversation does not wait for unused ${blockedRead} context` : "bootstrap still fetches and injects continuity, user card, and persona", async t => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fsp.mkdtemp(join(tmpdir(), "libravdb-bootstrap-reads-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const timeoutSpy = t.mock.method(globalThis, "setTimeout");
    let release!: () => void;
    const stalled = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    async function read(kind: string) {
      calls.push(kind);
      if (kind === blockedRead) await stalled;
    }
    const client = {
      async assembleContextInternal() { return { messages: [], estimatedTokens: 10, systemPromptAddition: "assembled context" }; },
      async searchTextCollections() {
        await read("continuity");
        return { results: [{ id: "__session_continuity__", metadataJson: new TextEncoder().encode(JSON.stringify({ session_id: "previous", summary_id: "summary" })) }] };
      },
      async expandSummary() { await read("summary"); return { text: "earlier conversation summary" }; },
      async getUserCard(p: { userId: string }) {
        const kind = p.userId === "__bot_persona__" ? "persona" : "user";
        await read(kind);
        return { cardJson: JSON.stringify({ card: kind === "persona" ? "helpful bot persona" : "known user card" }) };
      },
    };
    const runtime: PluginRuntime = { getClient: async () => client as never, onShutdown() {}, async shutdown() {}, async emitLifecycleHint() {} };
    const engine = buildContextEngineFactory(runtime, { userId: "tester", beforeTurnEnabled: false }, { info() {}, warn() {}, error() {} });
    let assembly: ReturnType<typeof engine.assemble> | undefined;
    t.after(async () => {
      release();
      await assembly;
      await engine.dispose();
      for (const call of timeoutSpy.mock.calls) clearTimeout(call.result);
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
      await fsp.rm(stateDir, { recursive: true, force: true });
    });
    const messages = [
      ...(blockedRead ? [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" }] : []),
      { role: "user", content: "Continue the conversation" },
    ];
    let completed = false;
    assembly = engine.assemble({ sessionId: randomUUID(), sessionKey: randomUUID(), messages, tokenBudget: 8000, prompt: "Continue the conversation" });
    void assembly.then(() => { completed = true; });
    if (blockedRead) {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(completed, true, "unused bootstrap context must not delay an already assembled follow-up turn");
      assert.deepEqual(calls, [], "no bootstrap-only RPC is needed for an established conversation");
      assert.equal((await assembly).systemPromptAddition, "assembled context");
    } else {
      const result = await assembly;
      assert.deepEqual(calls, ["continuity", "summary", "user", "persona"]);
      for (const text of ["assembled context", "earlier conversation summary", "known user card", "helpful bot persona"]) {
        assert.ok(result.systemPromptAddition.includes(text), `bootstrap retains ${text}`);
      }
    }
  });
}
