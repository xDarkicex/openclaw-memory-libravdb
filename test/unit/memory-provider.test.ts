import test from "node:test";
import assert from "node:assert/strict";

import { buildMemoryPromptSection } from "../../src/memory-provider.js";
import type { PluginConfig, SearchResult } from "../../src/types.js";

class FakeRpc {
  public calls = new Map<string, number>();

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
    switch (method) {
      case "search_text": {
        const collection = String(params.collection);
        const results: SearchResult[] =
          collection.startsWith("user:")
            ? [{ id: "u1", score: 0.9, text: "user recall", metadata: { userId: "u1", ts: Date.now(), collection } }]
            : collection === "global"
              ? [{ id: "g1", score: 0.7, text: "global recall", metadata: { ts: Date.now(), collection: "global" } }]
              : [];
        return { results } as T;
      }
      default:
        throw new Error(`unexpected rpc method: ${method}`);
    }
  }
}

test("memory prompt section returns string array with static header when no messages", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { topK: 8 };
  const getRpc = async () => rpc as never;

  const memorySection = buildMemoryPromptSection(getRpc, cfg);
  const result = memorySection({
    availableTools: new Set(["read", "exec"]),
  });

  assert.ok(Array.isArray(result), "result should be an array");
  assert.ok(result.length > 0, "result should not be empty");
  for (const line of result) {
    assert.equal(typeof line, "string", "each element should be a string");
  }
  assert.ok(result.some((line) => line.toLowerCase().includes("memory")));
});

test("memory prompt section stays synchronous and does not perform rpc lookups", () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { topK: 8 };
  const getRpc = async () => rpc as never;

  const memorySection = buildMemoryPromptSection(getRpc, cfg);
  const result = memorySection({
    availableTools: new Set(["libravdb_memory_search", "libravdb_memory_get"]),
  });

  assert.doesNotThrow(() => [...result], "host spreads the returned section immediately");
  assert.ok(Array.isArray(result), "result should be an array");
  assert.ok(result.length > 0, "result should not be empty");
  assert.equal(rpc.calls.get("search_text") ?? 0, 0, "should not perform search_text calls");
});

test("memory prompt section guides memory tool use when libravdb_memory_search is available", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { topK: 8, alpha: 0.7, beta: 0.2, gamma: 0.1 };
  const getRpc = async () => rpc as never;

  const memorySection = buildMemoryPromptSection(getRpc, cfg);
  const result = memorySection({
    availableTools: new Set(["libravdb_memory_search", "libravdb_memory_get"]),
  });

  const resultText = result.join("\n");
  assert.ok(resultText.includes("LibraVDB Memory"), "should include memory header");
  assert.ok(resultText.includes("once per user question"), "should guide per-question memory retrieval");
  assert.ok(resultText.includes("Call `libravdb_memory_search`"), "should guide explicit recall through libravdb_memory_search");
  assert.ok(resultText.includes("perform a search every time"), "should prevent stale transcript reuse");
  assert.ok(resultText.includes("auto-ingested"), "should describe auto-ingestion behavior");
  assert.ok(resultText.includes("call `libravdb_memory_get`"), "should guide exact recall through libravdb_memory_get");
  assert.ok(resultText.includes("vector-backed"), "should describe memory as vector-backed");
  assert.ok(!resultText.includes("recalled_memories"), "should not inject recalled memories directly");
  assert.ok(!resultText.includes("user recall") && !resultText.includes("global recall"), "should not render recall items");
  assert.equal(rpc.calls.get("search_text") ?? 0, 0, "should not perform search_text calls");
});

test("memory prompt section works with citationsMode", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { topK: 8 };
  const getRpc = async () => rpc as never;

  const memorySection = buildMemoryPromptSection(getRpc, cfg);
  const result = memorySection({
    availableTools: new Set(),
    citationsMode: "inline",
  });

  assert.ok(Array.isArray(result));
  assert.ok(result.some((line) => line.toLowerCase().includes("memory")));
});

test("causal traversal guidance includes the available causal follow-up tools", () => {
  const memorySection = buildMemoryPromptSection(async () => new FakeRpc() as never, { topK: 8 });

  const full = memorySection({ availableTools: new Set(["libravdb_memory_search", "libravdb_memory_get", "memory_expand", "get_user_card"]) }).join("\n");
  assert.match(full, /`libravdb_memory_search` for the people\/events/);
  assert.match(full, /use `libravdb_memory_get` for exact detail/);
  assert.match(full, /`get_user_card` to cross-reference/);

  const noGet = memorySection({ availableTools: new Set(["libravdb_memory_search", "memory_expand"]) }).join("\n");
  assert.match(noGet, /typed edge snippets/);
  assert.doesNotMatch(noGet, /use `libravdb_memory_get` for exact detail/);
  assert.doesNotMatch(noGet, /`get_user_card` to cross-reference/);
});

test("memory prompt does not instruct calls to unavailable tools", () => {
  const memorySection = buildMemoryPromptSection(async () => new FakeRpc() as never, {});
  const toolNames = ["libravdb_memory_search", "libravdb_memory_get", "get_user_card", "list_user_cards", "update_user_card", "memory_describe", "memory_expand", "memory_grep", "set_rule", "list_rules", "delete_rule"];

  for (const availableTools of [new Set<string>(), new Set(["libravdb_memory_search"]), new Set(["libravdb_memory_search", "get_user_card"])]) {
    const prompt = memorySection({ availableTools }).join("\n");
    for (const toolName of toolNames) {
      if (!availableTools.has(toolName)) assert.ok(!prompt.includes(toolName), `must not require unavailable ${toolName}`);
    }
  }
});

test("memory prompt guides card-only and recall-only surfaces without requiring search", () => {
  const memorySection = buildMemoryPromptSection(async () => new FakeRpc() as never, {});

  const cards = memorySection({ availableTools: new Set(["get_user_card", "update_user_card"]) }).join("\n");
  assert.match(cards, /get_user_card\(user_id\)/);
  assert.match(cards, /update_user_card/);
  assert.doesNotMatch(cards, /libravdb_memory_search/);

  const recall = memorySection({ availableTools: new Set(["memory_describe", "memory_expand"]) }).join("\n");
  assert.match(recall, /memory_describe\(summaryId\)/);
  assert.match(recall, /memory_expand\(summaryIds\)/);
  assert.doesNotMatch(recall, /libravdb_memory_search/);
});
