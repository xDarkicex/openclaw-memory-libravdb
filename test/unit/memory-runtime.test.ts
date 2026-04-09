import test from "node:test";
import assert from "node:assert/strict";

import { buildMemoryRuntimeBridge } from "../../src/memory-runtime.js";
import type { PluginConfig, SearchResult } from "../../src/types.js";

class FakeRpc {
  public calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });

    switch (method) {
      case "search_text_collections":
        {
          const collections = params.collections as string[] | undefined;
        return {
          results: [
            {
              id: "m1",
              score: 0.91,
              text: "remembered item",
              metadata: { collection: collections?.[0] ?? "user:u1" },
            },
          ],
        } as T;
        }
      case "status":
        return {
          ok: true,
          message: "ok",
          turnCount: 12,
          memoryCount: 4,
          gatingThreshold: 0.35,
          abstractiveReady: false,
          embeddingProfile: "nomic-embed-text-v1.5",
          sessionTurnCount: 7,
        } as T;
      case "list_collection":
        return {
          results: [
            {
              id: "m1",
              score: 0.91,
              text: "remembered item",
              metadata: { collection: String(params.collection) },
            },
          ],
        } as T;
      default:
        throw new Error(`unexpected rpc method: ${method}`);
    }
  }
}

test("memory runtime bridge searches the resolved durable namespace under the latest host contract", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { topK: 6, useSessionRecallProjection: true };
  const runtime = buildMemoryRuntimeBridge(async () => rpc as never, cfg);
  const { manager } = await runtime.getMemorySearchManager();
  const sessionKey = "fixed-session";

  const result = await manager.search({ query: "find prior context", sessionKey });
  assert.ok(Array.isArray(result));

  assert.equal(rpc.calls[0]?.method, "status");
  assert.equal(rpc.calls[1]?.method, "search_text_collections");
  assert.deepEqual(rpc.calls[1]?.params.collections, ["user:session-key:fixed-session", "global"]);
  assert.equal(rpc.calls[1]?.params.k, 6);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.snippet, "remembered item");
  assert.equal(result[0]?.source, "memory");
});

test("memory runtime bridge keeps the legacy string search shape", async () => {
  const rpc = new FakeRpc();
  const runtime = buildMemoryRuntimeBridge(async () => rpc as never, {});
  const { manager } = await runtime.getMemorySearchManager();

  const result = await manager.search("find prior context", { sessionKey: "fixed-session" }) as {
    results: Array<{ content: string }>;
  };

  assert.equal(Array.isArray(result), false);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.content, "remembered item");
});

test("memory runtime bridge round-trips encoded collection names in result paths", async () => {
  const rpc = new FakeRpc();
  const runtime = buildMemoryRuntimeBridge(async () => rpc as never, {});
  const { manager } = await runtime.getMemorySearchManager();

  const result = await manager.search({ query: "find prior context", userId: "u1::nested" }) as Array<{ path: string }>;
  const path = result[0]?.path;
  assert.equal(typeof path, "string");
  const loaded = await manager.readFile({ relPath: path ?? "", from: 1, lines: 1 });
  assert.equal(loaded.text, "remembered item");
});

test("memory runtime bridge exposes cached status and keeps legacy helpers delegated", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = {};
  const runtime = buildMemoryRuntimeBridge(async () => rpc as never, cfg);
  const { manager } = await runtime.getMemorySearchManager({ purpose: "status" });

  const status = manager.status();
  const ingest = await manager.ingest();
  const sync = await manager.sync();
  const probe = await manager.probeEmbeddingAvailability();

  assert.equal(status.ok, true);
  assert.equal(status.backend, "builtin");
  assert.equal(status.provider, "libravdb");
  assert.equal(status.turnCount, 12);
  assert.equal(status.embeddingProfile, "nomic-embed-text-v1.5");
  assert.equal(status.sessionTurnCount, 7);
  assert.deepEqual(ingest, { ingested: false, delegatedToContextEngine: true });
  assert.deepEqual(sync, { synced: true, delegatedToContextEngine: true });
  assert.deepEqual(probe, { ok: true });
});
