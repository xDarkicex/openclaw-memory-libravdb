import test from "node:test";
import assert from "node:assert/strict";

import { buildContextEngineFactory } from "../../src/context-engine.js";
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
