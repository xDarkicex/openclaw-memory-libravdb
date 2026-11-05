import test from "node:test";
import assert from "node:assert/strict";
import type { RegisteredMemorySearchManager } from "../../node_modules/openclaw/dist/plugins/memory-state.js";
import { SearchResult } from "@xdarkicex/libravdb-contracts";
import { buildMemoryRuntimeBridge } from "../../src/memory-runtime.js";

// Exercise the string call used by OpenClaw's native memory.search handler,
// including real protobuf uint64 fields rather than plain-object RPC fixtures.
test("native string searches return serializable hits that support exact reads", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const text = "First line\nSecond line";
  const rpc = {
    async status() { return { ok: true }; },
    async searchTextCollections(params: Record<string, unknown>) {
      calls.push(params);
      return { results: [
        new SearchResult({ id: "kept", score: 0.9, text, version: 9007199254740993n,
          metadataJson: new TextEncoder().encode(JSON.stringify({ collection: "user:u1" })) }),
        new SearchResult({ id: "hidden", score: 0.1, text: "below threshold" }),
      ] };
    },
  };
  const { manager } = await buildMemoryRuntimeBridge(async () => rpc as never, { userId: "u1" })
    .getMemorySearchManager({ agentId: "main" });
  assert.ok(manager);
  const host: Pick<RegisteredMemorySearchManager, "search" | "readFile"> = manager;
  const hits = await host.search("find context", { maxResults: 2, minScore: 0.5 });
  assert.ok(Array.isArray(hits), "OpenClaw consumes an array, not an RPC response envelope");
  assert.equal(calls[0]?.k, 2);
  assert.deepEqual(hits.map((hit) => hit.snippet), [text]);
  assert.deepEqual(JSON.parse(JSON.stringify({ results: hits })).results, hits);
  assert.equal(hits[0]?.source, "memory");
  const read = await manager.readFile({ relPath: hits[0]!.path, from: 2, lines: 1 });
  assert.equal(read.text, "Second line");
  await assert.rejects(manager.readFile({ relPath: "memory::hidden" }), /not returned/);
});

test("blank native string searches return an empty array without issuing an RPC", async () => {
  const rpc = {
    async status() { return { ok: true }; },
    async searchTextCollections() { assert.fail("blank query must not reach daemon"); },
  };
  const { manager } = await buildMemoryRuntimeBridge(async () => rpc as never, { userId: "u1" })
    .getMemorySearchManager();
  assert.ok(manager);
  assert.deepEqual(await manager.search("  ", { maxResults: 3 }), []);
});
