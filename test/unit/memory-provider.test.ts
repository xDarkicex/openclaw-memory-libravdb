import test from "node:test";
import assert from "node:assert/strict";

import { buildMemoryPromptSection } from "../../src/memory-provider.js";
import { createRecallCache } from "../../src/recall-cache.js";
import type { PluginConfig, SearchResult } from "../../src/types.js";

const cfg: PluginConfig = {
  rpcTimeoutMs: 1000,
  topK: 8,
  alpha: 0.7,
  beta: 0.2,
  gamma: 0.1,
};

test("memory prompt returns empty content for empty query", async () => {
  const rpc = { call: async () => ({ results: [] }) };
  const section = buildMemoryPromptSection(
    (async () => rpc) as never,
    cfg,
    createRecallCache<SearchResult>(),
  );

  const result = await section({ userId: "u1", messages: [] });
  assert.equal(result.content, "");
});

test("memory prompt handles RPC failure with empty results", async () => {
  const rpc = { call: async () => { throw new Error("boom"); } };
  const section = buildMemoryPromptSection(
    (async () => rpc) as never,
    cfg,
    createRecallCache<SearchResult>(),
  );

  const result = await section({
    userId: "u1",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(result.id, "libravdb-memory");
  assert.equal(result.content, "");
});
