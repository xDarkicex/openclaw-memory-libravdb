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

type FakeSearchResult = {
  id: string;
  score: number;
  text: string;
  metadataJson?: Uint8Array;
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

  async searchText(params: Record<string, unknown>): Promise<{ results: FakeSearchResult[] }> {
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
}

function encodeMetadata(value: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

class CollectionRecallClient extends FakeRecallClient {
  constructor(private readonly resultsByCollection: Record<string, FakeSearchResult[]>) {
    super();
  }

  override async searchText(params: Record<string, unknown>): Promise<{ results: FakeSearchResult[] }> {
    this.calls.push({ method: "searchText", params });
    const collection = typeof params.collection === "string" ? params.collection : "";
    return {
      results: this.resultsByCollection[collection] ?? [],
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
  assert.equal(client.calls[0]?.method, "searchText");
  assert.equal(client.calls[0]?.params.collection, "session_summary:active-session");
  assert.equal(client.calls.length, 1);
});

test("memory_grep does not query message collections without a session id", async () => {
  const client = new CollectionRecallClient({
    "session_raw:": [{
      id: "turn-1",
      score: 0.99,
      text: "needle in malformed collection",
      metadataJson: encodeMetadata({ role: "user" }),
    }],
  });
  const tool = createMemoryGrepTool(
    async () => client as unknown as LibravDBClient,
    () => undefined,
    silentLogger,
  );

  const result = await tool.execute("call-1", { pattern: "needle", scope: "messages" });
  const details = result.details as { totalMatches: number; turns: Array<{ turnId: string }> };

  assert.equal(details.totalMatches, 0);
  assert.deepEqual(details.turns, []);
  assert.equal(client.calls.length, 0);
});

test("memory_grep searches the default active session collection for messages", async () => {
  const client = new CollectionRecallClient({
    "session_raw:active-session": [],
    "session:active-session": [{
      id: "turn-1",
      score: 0.88,
      text: "needle inside default session collection",
      metadataJson: encodeMetadata({ role: "user" }),
    }],
  });
  const tool = createMemoryGrepTool(
    async () => client as unknown as LibravDBClient,
    () => "active-session",
    silentLogger,
  );

  const result = await tool.execute("call-1", { pattern: "needle", scope: "messages" });
  const details = result.details as { totalMatches: number; turns: Array<{ turnId: string; snippet: string; role: string; score: number }> };

  assert.equal(details.totalMatches, 1);
  assert.deepEqual(client.calls.map((call) => call.params.collection), [
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

test("memory_grep treats non-object message metadata as missing", async () => {
  const client = new CollectionRecallClient({
    "session_raw:active-session": [{
      id: "turn-1",
      score: 0.77,
      text: "needle survives non-object metadata",
      metadataJson: new TextEncoder().encode("null"),
    }],
    "session:active-session": [],
  });
  const tool = createMemoryGrepTool(
    async () => client as unknown as LibravDBClient,
    () => "active-session",
    silentLogger,
  );

  const result = await tool.execute("call-1", { pattern: "needle", scope: "messages" });
  const details = result.details as { totalMatches: number; turns: Array<{ turnId: string; snippet: string; role: string; score: number }> };

  assert.equal(details.totalMatches, 1);
  assert.deepEqual(details.turns, [{
    turnId: "turn-1",
    snippet: "needle survives non-object metadata",
    role: "unknown",
    score: 0.77,
  }]);
});

test("memory_grep keeps independent summary and message budgets", async () => {
  const client = new CollectionRecallClient({
    "session_summary:active-session": [{
      id: "sum_1",
      score: 0.7,
      text: "needle inside summary text",
      metadataJson: encodeMetadata({ eviction_cue: "summary cue" }),
    }],
    "session_raw:active-session": [],
    "session:active-session": [{
      id: "turn-1",
      score: 0.99,
      text: "needle inside default session collection",
      metadataJson: encodeMetadata({ role: "assistant" }),
    }],
  });
  const tool = createMemoryGrepTool(
    async () => client as unknown as LibravDBClient,
    () => "active-session",
    silentLogger,
  );

  const result = await tool.execute("call-1", { pattern: "needle", scope: "both", limit: 1 });
  const details = result.details as {
    totalMatches: number;
    summaries: Array<{ summaryId: string; snippet: string; score: number; evictionCue?: string }>;
    turns: Array<{ turnId: string; snippet: string; role: string; score: number }>;
  };

  assert.deepEqual(client.calls.map((call) => call.params.collection), [
    "session_summary:active-session",
    "session_raw:active-session",
    "session:active-session",
  ]);
  assert.equal(details.totalMatches, 2);
  assert.deepEqual(details.summaries, [{
    summaryId: "sum_1",
    snippet: "needle inside summary text",
    score: 0.7,
    evictionCue: "summary cue",
  }]);
  assert.deepEqual(details.turns, [{
    turnId: "turn-1",
    snippet: "needle inside default session collection",
    role: "assistant",
    score: 0.99,
  }]);
});

test("memory_grep deduplicates messages only after exact matching", async () => {
  const client = new CollectionRecallClient({
    "session_raw:active-session": [{
      id: "turn-1",
      score: 0.99,
      text: "semantic neighbor without the target phrase",
      metadataJson: encodeMetadata({ role: "user" }),
    }],
    "session:active-session": [{
      id: "turn-1",
      score: 0.5,
      text: "needle appears in the default session collection",
      metadataJson: encodeMetadata({ role: "assistant" }),
    }],
  });
  const tool = createMemoryGrepTool(
    async () => client as unknown as LibravDBClient,
    () => "active-session",
    silentLogger,
  );

  const result = await tool.execute("call-1", { pattern: "needle", scope: "messages" });
  const details = result.details as { totalMatches: number; turns: Array<{ turnId: string; snippet: string; role: string; score: number }> };

  assert.equal(details.totalMatches, 1);
  assert.deepEqual(details.turns, [{
    turnId: "turn-1",
    snippet: "needle appears in the default session collection",
    role: "assistant",
    score: 0.5,
  }]);
});

test("memory_grep keeps the highest-scored duplicate message hit", async () => {
  const client = new CollectionRecallClient({
    "session_raw:active-session": [{
      id: "turn-1",
      score: 0.71,
      text: "needle inside duplicate raw collection",
      metadataJson: encodeMetadata({ role: "user" }),
    }],
    "session:active-session": [{
      id: "turn-1",
      score: 0.88,
      text: "needle inside default session collection",
      metadataJson: encodeMetadata({ role: "user" }),
    }],
  });
  const tool = createMemoryGrepTool(
    async () => client as unknown as LibravDBClient,
    () => "active-session",
    silentLogger,
  );

  const result = await tool.execute("call-1", { pattern: "needle", scope: "messages" });
  const details = result.details as { totalMatches: number; turns: Array<{ turnId: string; snippet: string; role: string; score: number }> };

  assert.equal(details.totalMatches, 1);
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
