import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryGrepTool } from "../../src/tools/memory-recall.js";
import type { LibravDBClient } from "../../src/libravdb-client.js";

type Hit = { id: string; text: string; score: number; metadataJson?: Uint8Array };
function setup(collections: Record<string, Hit[]>, sessionId = "active") {
  const calls: string[] = [];
  const client = {
    async searchText({ collection }: { collection: string }) {
      calls.push(collection);
      return { results: collections[collection] ?? [] };
    },
  } as unknown as LibravDBClient;
  return { calls, tool: createMemoryGrepTool(async () => client, () => sessionId) };
}

test("message grep finds default-session records and tolerates non-object metadata", async () => {
  const { tool, calls } = setup({ "session:active": [
    { id: "default-turn", text: "needle in ordinary session", score: 0.8, metadataJson: new TextEncoder().encode("null") },
  ] });
  const result = await tool.execute("grep", { pattern: "needle", scope: "messages" });
  assert.deepEqual(result.details.turns, [{ turnId: "default-turn", snippet: "needle in ordinary session", score: 0.8, role: "unknown" }]);
  assert.deepEqual(calls, ["session_raw:active", "session:active"]);
});

test("message grep filters before deduplicating and budgets unique highest-scored turns", async () => {
  const { tool } = setup({
    "session_raw:active": [
      { id: "turn-1", text: "semantic neighbor only", score: 1 },
      { id: "turn-2", text: "needle low", score: 0.2 },
    ],
    "session:active": [
      { id: "turn-1", text: "needle one", score: 0.8 },
      { id: "turn-2", text: "needle high", score: 0.9 },
    ],
  });
  const result = await tool.execute("grep", { pattern: "needle", scope: "messages", limit: 2 });
  assert.deepEqual(result.details.turns.map(hit => [hit.turnId, hit.snippet]), [["turn-2", "needle high"], ["turn-1", "needle one"]]);
  assert.equal(result.details.totalMatches, 2);
  assert.equal(result.details.truncated, false);
  const limited = await tool.execute("grep", { pattern: "needle", scope: "messages", limit: 1 });
  assert.equal(limited.details.turns[0]?.turnId, "turn-2");
  assert.equal(limited.details.truncated, true);
});

test("grep keeps the combined result cap and summary-only collection scope", async () => {
  const { tool, calls } = setup({
    "session_summary:active": [{ id: "summary", text: "needle summary", score: 0.5 }],
    "session:active": [{ id: "turn", text: "needle turn", score: 0.9 }],
  });
  const summaries = await tool.execute("grep", { pattern: "needle", scope: "summaries", limit: 1 });
  assert.equal(summaries.details.totalMatches, 1);
  assert.deepEqual(calls, ["session_summary:active"]);
  const both = await tool.execute("grep", { pattern: "needle", scope: "both", limit: 1 });
  assert.equal(both.details.totalMatches, 1);
  assert.equal(both.details.summaries.length, 1);
  assert.equal(both.details.turns.length, 0);
  assert.equal(both.details.truncated, true);
});

test("message grep without a session does not query malformed collections", async () => {
  const { tool, calls } = setup({}, "");
  const result = await tool.execute("grep", { pattern: "needle", scope: "messages" });
  assert.equal(result.details.totalMatches, 0);
  assert.deepEqual(calls, []);
});
