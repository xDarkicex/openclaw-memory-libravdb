import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildContextEngineFactory, FLUSH_ASYNC_INGESTION } from "../../src/context-engine.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";
import type { LibravDBClient } from "../../src/libravdb-client.js";

for (const change of ["runtime", "client"] as const) {
  test(`post-tool recall does not reuse another destination after changing ${change}`, async () => {
    const assemblies: string[] = [];
    function client(destination: string): LibravDBClient {
      return {
        async assembleContextInternal() {
          assemblies.push(destination);
          return { messages: [], estimatedTokens: 0, systemPromptAddition: `<memory_context>private ${destination} fact</memory_context>` };
        },
      } as unknown as LibravDBClient;
    }
    const firstClient = client("first");
    const secondClient = client("second");
    let activeClient = firstClient;
    function runtime(): PluginRuntime {
      return { getClient: async () => activeClient, onShutdown() {}, async shutdown() {}, async emitLifecycleHint() {} };
    }
    const firstRuntime = runtime();
    const cfg = { userId: "tester", beforeTurnEnabled: false };
    const logger = { info() {}, warn() {}, error() {} };
    const first = buildContextEngineFactory(firstRuntime, cfg, logger);
    const next = buildContextEngineFactory(change === "runtime" ? runtime() : firstRuntime, cfg, logger);
    const user = { role: "user", id: "same-user-turn", content: "look up the current fact" };
    const args = { sessionId: randomUUID(), messages: [user], tokenBudget: 4000 };
    const continuationArgs = { ...args, messages: [user,
      { role: "assistant", content: [{ type: "toolCall", id: "lookup", name: "lookup", arguments: {} }] },
      { role: "toolResult", toolCallId: "lookup", content: "lookup finished" },
    ] };
    try {
      assert.match((await first.assemble(args)).systemPromptAddition, /private first fact/);
      activeClient = secondClient;
      const continuation = await next.assemble(continuationArgs);
      assert.deepEqual(assemblies, ["first", "second"], "a different daemon client must assemble its own context");
      assert.match(continuation.systemPromptAddition, /private second fact/);
      assert.doesNotMatch(continuation.systemPromptAddition, /private first fact/);
      await next.assemble(continuationArgs);
      assert.deepEqual(assemblies, ["first", "second"], "same-client continuations still reuse recall");
    } finally { await first.dispose(); await next.dispose(); }
  });
}

for (const firstOutcome of ["prediction", "failure", "auth"] as const) {
  test(`before-turn recall state stays with its client after ${firstOutcome}`, async () => {
    const retrievals: string[] = [];
    function client(destination: string): LibravDBClient {
      return {
        async beforeTurnKernel() {
          retrievals.push(destination);
          if (destination === "first" && firstOutcome !== "prediction") {
            throw Object.assign(new Error("first destination failed"), { code: firstOutcome === "auth" ? 16 : 2 });
          }
          return { predictions: [{ text: `private ${destination} fact`, score: 0.9 }] };
        },
        async assembleContextInternal() { return { messages: [], estimatedTokens: 0, systemPromptAddition: "" }; },
      } as unknown as LibravDBClient;
    }
    const firstClient = client("first");
    const secondClient = client("second");
    let activeClient = firstClient;
    const runtime: PluginRuntime = {
      getClient: async () => activeClient, onShutdown() {}, async shutdown() {}, async emitLifecycleHint() {},
    };
    const engine = buildContextEngineFactory(runtime, { userId: "tester", assembleTimeoutMs: 1000 }, { info() {}, warn() {}, error() {} });
    const args = { sessionId: randomUUID(), messages: [{ role: "user", id: "same-turn", content: "look up the current fact" }], tokenBudget: 4000 };
    try {
      const initial = await engine.assemble(args);
      if (firstOutcome === "prediction") assert.match(initial.systemPromptAddition, /private first fact/);
      activeClient = secondClient;
      const nextArgs = firstOutcome === "auth"
        ? { ...args, messages: [{ ...args.messages[0], id: "next-user-turn" }] } : args;
      const next = await engine.assemble(nextArgs);
      assert.deepEqual(retrievals, ["first", "second"], "another client's cached result, attempt, or circuit must not suppress retrieval");
      assert.match(next.systemPromptAddition, /private second fact/);
      assert.doesNotMatch(next.systemPromptAddition, /private first fact/);
      await engine.assemble(nextArgs);
      assert.deepEqual(retrievals, ["first", "second"], "same-client retry reuses its own state");
    } finally { await engine.dispose(); }
  });
}

test("after-turn predictions are consumed only by the client that produced them", async () => {
  function client(): LibravDBClient {
    return {
      async afterTurnKernel() { return { ok: true, predictions: [{ text: "private first forecast" }] }; },
      async assembleContextInternal() { return { messages: [], estimatedTokens: 0, systemPromptAddition: "" }; },
    } as unknown as LibravDBClient;
  }
  const firstClient = client();
  const secondClient = client();
  let activeClient = firstClient;
  const runtime: PluginRuntime = { getClient: async () => activeClient, onShutdown() {}, async shutdown() {}, async emitLifecycleHint() {} };
  const engine = buildContextEngineFactory(runtime, { userId: "tester", beforeTurnEnabled: false, assembleTimeoutMs: 1000 }, { info() {}, warn() {}, error() {} });
  async function seed() {
    const sessionId = randomUUID();
    activeClient = firstClient;
    await engine.afterTurn({ sessionId, messages: [{ role: "user", content: "remember this" }] });
    await engine[FLUSH_ASYNC_INGESTION]();
    return { sessionId, messages: [{ role: "user", content: "continue" }], tokenBudget: 4000 };
  }
  try {
    const control = await seed();
    assert.match((await engine.assemble(control)).systemPromptAddition, /private first forecast/);
    const changed = await seed();
    activeClient = secondClient;
    assert.doesNotMatch((await engine.assemble(changed)).systemPromptAddition, /private first forecast/);
  } finally { await engine.dispose(); }
});
