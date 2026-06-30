import test from "node:test";
import assert from "node:assert/strict";

import { buildContextEngineFactory, consumeSubagentBudget } from "../../src/context-engine.js";
import {
  createGetUserCardTool,
  createListUserCardsTool,
  createMemoryDescribeTool,
  createMemoryExpandTool,
  createMemoryGrepTool,
} from "../../src/tools/memory-recall.js";
import type { LibravDBClient } from "../../src/libravdb-client.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";

const silentLogger = {
  error(_message: string) {},
  warn(_message: string) {},
  info(_message: string) {},
};

class FakeRecallClient {
  public calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  public listResults: unknown[] = [];
  public cards = new Map<string, { cardJson: string; updatedAt: number; version: number }>();

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

  async listByMeta(params: Record<string, unknown>) {
    this.calls.push({ method: "listByMeta", params });
    return { results: this.listResults };
  }

  async getUserCard(params: Record<string, unknown>) {
    this.calls.push({ method: "getUserCard", params });
    return this.cards.get(String(params.userId)) ?? { cardJson: "", updatedAt: 0, version: 0 };
  }
}

function userCardResult(userId: string, card: string, updatedAt = 100, version = 1, source?: string) {
  return {
    metadataJson: new TextEncoder().encode(JSON.stringify({
      _user_id: userId,
      card_json: JSON.stringify(source ? { card, source } : { card }),
      updated_at: updatedAt,
      version,
    })),
  };
}

test("get_user_card guidance allows memory follow-up for sparse profile cards", () => {
  const tool = createGetUserCardTool(
    async () => new FakeRecallClient() as unknown as LibravDBClient,
    silentLogger,
  );

  assert.match(tool.description, /call memory_search after the card/u);
  assert.doesNotMatch(tool.description, /Only fall through to memory_search if the card is empty or missing/u);
});

test("get_user_card resolves raw sender IDs to scoped user-card projections", async () => {
  const client = new FakeRecallClient();
  client.listResults = [
    userCardResult("discord|guild=g|channel=c|sender=399", "scoped human card", 200, 2, "openclaw-user-cards"),
    userCardResult("discord|guild=g|channel=other|sender=399", "older card", 100, 1, "openclaw-user-cards"),
  ];
  const tool = createGetUserCardTool(
    async () => client as unknown as LibravDBClient,
    silentLogger,
  );

  const result = await tool.execute("call-1", { user_id: "399" });

  assert.deepEqual(result.details, {
    card: "scoped human card",
    updatedAt: 200,
    version: 2,
  });
  assert.deepEqual(client.calls.map((call) => call.method), ["getUserCard", "listByMeta"]);
});

test("get_user_card resolves visible aliases from card identity fields", async () => {
  const client = new FakeRecallClient();
  client.listResults = [
    userCardResult(
      "discord|channel=c|sender=1001",
      [
        "Stable identity card projected by OpenClaw user-cards.",
        "- speaker id: 1001",
        "- visible names: ExampleUser-1001",
        "Relevant high-signal notes:",
        "- not part of identity lookup",
      ].join("\n"),
      200,
      2,
      "openclaw-user-cards",
    ),
  ];
  const tool = createGetUserCardTool(
    async () => client as unknown as LibravDBClient,
    silentLogger,
  );

  const result = await tool.execute("call-1", { user_id: "ExampleUser-1001" });

  assert.equal(result.details.card?.includes("- visible names: ExampleUser-1001"), true);
  assert.equal(result.details.updatedAt, 200);
  assert.equal(result.details.version, 2);
});

test("get_user_card alias fallback ignores names that appear only in notes", async () => {
  const client = new FakeRecallClient();
  client.listResults = [
    userCardResult(
      "discord|channel=c|sender=1",
      [
        "User card: Other Person",
        "Known aliases: Other",
        "Relevant high-signal notes:",
        "- talked about ExampleUser-1001 once",
      ].join("\n"),
      200,
      2,
      "openclaw-user-cards",
    ),
  ];
  const tool = createGetUserCardTool(
    async () => client as unknown as LibravDBClient,
    silentLogger,
  );

  const result = await tool.execute("call-1", { user_id: "ExampleUser-1001" });

  assert.deepEqual(result.details, { card: null, updatedAt: undefined, version: undefined });
});

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

test("list_user_cards deduplicates daemon index projection variants", async () => {
  const client = new FakeRecallClient();
  client.listResults = [
    userCardResult("discord|channel=c|sender=1:256d", "projection 256d"),
    userCardResult("discord|channel=c|sender=1", "canonical card"),
    userCardResult("discord|channel=c|sender=1:64d", "projection 64d"),
    userCardResult("discord|channel=c|sender=2:64d", "only projection"),
    userCardResult("discord|channel=c|sender=3", "foreign source", 100, 1, "codex-test"),
  ];
  const tool = createListUserCardsTool(
    async () => client as unknown as LibravDBClient,
    silentLogger,
  );

  const result = await tool.execute("call-1", {});

  assert.deepEqual(result.details, {
    users: [
      { user_id: "discord|channel=c|sender=1", preview: "canonical card", updated_at: 100, version: 1 },
      { user_id: "discord|channel=c|sender=2", preview: "only projection", updated_at: 100, version: 1 },
    ],
    total: 2,
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
