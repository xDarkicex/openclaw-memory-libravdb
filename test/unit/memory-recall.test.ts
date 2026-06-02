import test from "node:test";
import assert from "node:assert/strict";

import { buildContextEngineFactory, consumeSubagentBudget } from "../../src/context-engine.js";
import { createMemoryDescribeTool, createMemoryExpandTool, createMemoryGrepTool } from "../../src/tools/memory-recall.js";
import type { LibravDBClient } from "../../src/libravdb-client.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";

const silentLogger = {
  error(_message: string) {},
  warn(_message: string) {},
  info(_message: string) {},
};

class FakeRecallClient {
  public calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  async expandSummary(params: Record<string, unknown>) {
    this.calls.push({ method: "expandSummary", params });
    return {
      text: "expanded summary text",
      metadataJson: new TextEncoder().encode(JSON.stringify({
        eviction_cue: "summary cue",
        continuity_lineage: {
          source_turn_ids: ["turn-1"],
          parent_summary_ids: ["sum-parent"],
        },
      })),
    };
  }

  async searchText(params: Record<string, unknown>) {
    this.calls.push({ method: "searchText", params });
    return {
      results: [{
        id: "sum-1",
        score: 0.9,
        text: "needle inside summary text",
        metadataJson: new TextEncoder().encode(JSON.stringify({
          role: "assistant",
          eviction_cue: "summary cue",
        })),
      }],
    };
  }

  async searchTextCollections(params: Record<string, unknown>) {
    this.calls.push({ method: "searchTextCollections", params });
    const collections = params.collections as string[] | undefined;
    return {
      results: [{
        id: "sum-1",
        score: 0.9,
        text: "needle inside summary text",
        metadataJson: new TextEncoder().encode(JSON.stringify({
          collection: collections?.[0] ?? "session_summary:active-session",
          role: "assistant",
          eviction_cue: "summary cue",
        })),
      }],
    };
  }
}

class DefaultSessionRecallClient extends FakeRecallClient {
  override async searchTextCollections(params: Record<string, unknown>) {
    this.calls.push({ method: "searchTextCollections", params });
    return {
      results: [{
        id: "turn-1",
        score: 0.88,
        text: "needle inside default session collection",
        metadataJson: new TextEncoder().encode(JSON.stringify({
          collection: "session:active-session",
          role: "user",
        })),
      }],
    };
  }
}

function fakeRuntime(client: FakeRecallClient): PluginRuntime {
  return {
    getClient: async () => client as unknown as LibravDBClient,
    emitLifecycleHint: async () => {},
    onShutdown: () => {},
    shutdown: async () => {},
  };
}

test("memory_describe defaults to the active session id", async () => {
  const client = new FakeRecallClient();
  const tool = createMemoryDescribeTool(
    async () => client as unknown as LibravDBClient,
    () => "active-session",
    silentLogger,
  );

  const result = await tool.execute("call-1", { summaryId: "sum-1" });

  assert.equal((result.details as { found: boolean }).found, true);
  assert.deepEqual(client.calls[0], {
    method: "expandSummary",
    params: { sessionId: "active-session", summaryId: "sum-1", maxDepth: 0 },
  });
});

test("memory_grep defaults to the active session id", async () => {
  const client = new FakeRecallClient();
  const tool = createMemoryGrepTool(
    async () => client as unknown as LibravDBClient,
    () => "active-session",
    silentLogger,
  );

  const result = await tool.execute("call-1", { pattern: "needle", scope: "summaries" });

  assert.equal((result.details as { totalMatches: number }).totalMatches, 1);
  assert.equal(client.calls[0]?.method, "searchTextCollections");
  assert.deepEqual(client.calls[0]?.params.collections, [
    "session_summary:active-session",
    "session:active-session",
  ]);
});

test("memory_grep searches the default active session collection", async () => {
  const client = new DefaultSessionRecallClient();
  const tool = createMemoryGrepTool(
    async () => client as unknown as LibravDBClient,
    () => "active-session",
    silentLogger,
  );

  const result = await tool.execute("call-1", { pattern: "needle", scope: "messages" });
  const details = result.details as { totalMatches: number; turns: Array<{ turnId: string; role: string }> };

  assert.equal(details.totalMatches, 1);
  assert.deepEqual(client.calls[0]?.params.collections, [
    "session_raw:active-session",
    "session:active-session",
  ]);
  assert.deepEqual(details.turns, [{
    turnId: "turn-1",
    snippet: "needle inside default session collection",
    role: "user",
    score: 0.88,
  }]);
});

test("memory_expand defaults to the active session id", async () => {
  const client = new FakeRecallClient();
  const tool = createMemoryExpandTool(
    async () => client as unknown as LibravDBClient,
    () => undefined,
    silentLogger,
    () => "active-session",
  );

  const result = await tool.execute("call-1", { summaryIds: ["sum-1"] });

  assert.equal((result.details as { summaryId: string }).summaryId, "sum-1");
  assert.deepEqual(client.calls[0], {
    method: "expandSummary",
    params: { sessionId: "active-session", summaryId: "sum-1", maxDepth: 1 },
  });
});

test("memory_expand explicit session id takes precedence over active session id", async () => {
  const client = new FakeRecallClient();
  const tool = createMemoryExpandTool(
    async () => client as unknown as LibravDBClient,
    () => undefined,
    silentLogger,
    () => "active-session",
  );

  const result = await tool.execute("call-1", {
    summaryIds: ["sum-1"],
    sessionId: "explicit-session",
  });

  assert.equal((result.details as { summaryId: string }).summaryId, "sum-1");
  assert.deepEqual(client.calls[0], {
    method: "expandSummary",
    params: { sessionId: "explicit-session", summaryId: "sum-1", maxDepth: 1 },
  });
});

test("memory_expand uses remaining subagent budget instead of dropping the first oversized request", async () => {
  const client = new FakeRecallClient();
  const engine = buildContextEngineFactory(fakeRuntime(client), { userId: "u1", subagentTokenBudget: 1000 }, silentLogger);
  await engine.prepareSubagentSpawn({
    parentSessionKey: "parent",
    childSessionKey: "child",
  });
  const tool = createMemoryExpandTool(
    async () => client as unknown as LibravDBClient,
    () => "child",
    silentLogger,
  );

  const result = await tool.execute("call-1", { summaryIds: ["sum-1"], maxTokens: 8000 });

  assert.equal((result.details as { exceededBudget: boolean }).exceededBudget, false);
  assert.match((result.details as { text: string }).text, /expanded summary text/);
  assert.equal(client.calls[0]?.method, "expandSummary");
});

test("subagent spawn sanitizes invalid numeric expansion budgets", async () => {
  for (const [index, subagentTokenBudget] of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
  ].entries()) {
    const client = new FakeRecallClient();
    const engine = buildContextEngineFactory(
      fakeRuntime(client),
      { userId: "u1", subagentTokenBudget },
      silentLogger,
    );
    const childSessionKey = `child-invalid-budget-${index}`;

    await engine.prepareSubagentSpawn({
      parentSessionKey: "parent",
      childSessionKey,
    });

    assert.equal(consumeSubagentBudget(childSessionKey, 100), 100);
    assert.equal(consumeSubagentBudget(childSessionKey, 10_000), 7_900);
    await engine.onSubagentEnded({ childSessionKey, reason: "test" });
  }
});
