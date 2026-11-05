import test from "node:test";
import assert from "node:assert/strict";
import { buildContextEngineFactory } from "../../src/context-engine.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";
import type { LibravDBClient } from "../../src/libravdb-client.js";

function setup() {
  let retrievals = 0;
  let assemblies = 0;
  const client = {
    async beforeTurnKernel() { return { predictions: [{ text: `retrieval version ${++retrievals}` }] }; },
    async assembleContextInternal() {
      return { messages: [], estimatedTokens: 0, systemPromptAddition: `<memory_context>assembly version ${++assemblies}</memory_context>` };
    },
  } as unknown as LibravDBClient;
  const runtime: PluginRuntime = { getClient: async () => client, onShutdown() {}, async shutdown() {}, async emitLifecycleHint() {} };
  return { runtime, counts: () => ({ retrievals, assemblies }) };
}
const logger = { info() {}, warn() {}, error() {} };
for (const change of ["identity", "query-tail"]) {
  test(`before-turn cache distinguishes equal-length histories with a new ${change}`, async () => {
    const { runtime, counts } = setup();
    const engine = buildContextEngineFactory(runtime, { userId: "tester" }, logger);
    const prefix = "shared query prefix ".repeat(12);
    const message = { role: "user", id: "turn-a", content: change === "identity" ? "what is current?" : prefix + "first question" };
    const args = { sessionId: `cache-boundary-${change}`, messages: [message], tokenBudget: 4000 };
    try {
      const first = await engine.assemble(args);
      assert.match(first.systemPromptAddition, /retrieval version 1/);
      const retry = await engine.assemble(args);
      assert.equal(counts().retrievals, 1, "retrying the same turn should reuse retrieval");
      assert.match(retry.systemPromptAddition, /retrieval version 1/);
      const next = await engine.assemble({ ...args, messages: [{ ...message, ...(change === "identity" ? { id: "turn-b" } : { content: prefix + "second question" }) }] });
      assert.equal(counts().retrievals, 2, "a distinct turn must retrieve even when message count and query prefix match");
      assert.match(next.systemPromptAddition, /retrieval version 2/);
      assert.doesNotMatch(next.systemPromptAddition, /retrieval version 1/);
    } finally { await engine.dispose(); }
  });
}

test("post-tool cache validates the user boundary across replacement engines", async () => {
  const { runtime, counts } = setup();
  const cfg = { userId: "tester", beforeTurnEnabled: false };
  const firstEngine = buildContextEngineFactory(runtime, cfg, logger);
  const nextEngine = buildContextEngineFactory(runtime, cfg, logger);
  const user = { role: "user", content: "first question", id: "user-a" };
  const toolTail = [
    { role: "assistant", content: [{ type: "toolCall", id: "lookup-call", name: "lookup", arguments: {} }] },
    { role: "toolResult", content: "lookup result", toolCallId: "lookup-call" },
  ];
  const args = { sessionId: "post-tool-boundary-replacement", messages: [user], tokenBudget: 4000 };
  try {
    await firstEngine.assemble(args);
    const continuation = await nextEngine.assemble({ ...args, messages: [user, ...toolTail] });
    assert.equal(counts().assemblies, 1, "same-turn continuation should reuse shared recall");
    assert.match(continuation.systemPromptAddition, /assembly version 1/);
    const changedUser = { ...user, content: "second question", id: "user-b" };
    const changed = await nextEngine.assemble({ ...args, messages: [changedUser, ...toolTail] });
    assert.equal(counts().assemblies, 2, "same user index does not establish the same turn");
    assert.match(changed.systemPromptAddition, /assembly version 2/);
    assert.doesNotMatch(changed.systemPromptAddition, /assembly version 1/);
    await nextEngine.assemble({ ...args, messages: [changedUser, ...toolTail] });
    assert.equal(counts().assemblies, 2);
  } finally { await firstEngine.dispose(); await nextEngine.dispose(); }
});
