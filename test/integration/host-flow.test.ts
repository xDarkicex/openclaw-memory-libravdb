import test from "node:test";
import assert from "node:assert/strict";

import { buildContextEngineFactory } from "../../src/context-engine.js";
import { buildMemoryPromptSection } from "../../src/memory-provider.js";
import { createRecallCache } from "../../src/recall-cache.js";
import type { PluginConfig, SearchResult } from "../../src/types.js";

class FakeRpc {
  public inserted: Array<{ collection: string; text: string; metadata?: Record<string, unknown> }> = [];
  public compactParams: Record<string, unknown> | null = null;
  public calls = new Map<string, number>();
  public gatingResult = {
    g: 0.9,
    t: 0.8,
    h: 0.8,
    r: 0.7,
    d: 0.6,
    p: 0.9,
    a: 0.5,
    dtech: 0.7,
    gconv: 0.65,
    gtech: 0.85,
    inputFreq: 1,
    memSaturation: 0,
  };

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
    switch (method) {
      case "health":
        return { ok: true } as T;
      case "flush":
        return {} as T;
      case "ensure_collections":
        return { ok: true } as T;
      case "insert_text":
        this.inserted.push({
          collection: String(params.collection),
          text: String(params.text),
          metadata: params.metadata as Record<string, unknown> | undefined,
        });
        return { ok: true } as T;
      case "gating_scalar":
        return this.gatingResult as T;
      case "search_text": {
        const collection = String(params.collection);
        const results: SearchResult[] =
          collection.startsWith("session:")
            ? [{
                id: collection,
                score: 0.8,
                text: `session recall for ${collection}`,
                metadata: { sessionId: collection.slice("session:".length), ts: Date.now(), collection },
              }]
            : [];
        return { results } as T;
      }
      case "search_text_collections": {
        const results: SearchResult[] = [
          { id: "u1", score: 0.9, text: "user recall", metadata: { userId: "u1", ts: Date.now(), collection: "user:u1" } },
          { id: "av1", score: 0.95, text: "authored variant recall", metadata: { authored: true, tier: 0, source_doc: "AGENTS.md", ts: Date.now(), hop_targets: ["av2"], collection: "authored:variant" } },
          { id: "g1", score: 0.7, text: "global recall", metadata: { ts: Date.now(), collection: "global" } },
        ];
        return { results } as T;
      }
      case "list_collection": {
        const collection = String(params.collection);
        const results: SearchResult[] =
          collection === "authored:hard"
            ? [{ id: "AGENTS.md#000001", score: 0, text: "Always cite the governing math.", metadata: { authored: true, tier: 1, ordinal: 1, source_doc: "AGENTS.md", token_estimate: 6 } }]
            : collection === "authored:soft"
              ? [{ id: "AGENTS.md#000002", score: 0, text: "Prefer exact formulas.", metadata: { authored: true, tier: 2, ordinal: 2, source_doc: "AGENTS.md", token_estimate: 5 } }]
              : collection === "authored:variant"
                ? [
                    { id: "av1", score: 0, text: "authored variant recall", metadata: { authored: true, tier: 0, source_doc: "AGENTS.md", ts: Date.now(), hop_targets: ["av2"], token_estimate: 3 } },
                    { id: "av2", score: 0, text: "authored hop recall", metadata: { authored: true, tier: 0, source_doc: "AGENTS.md", ts: Date.now(), token_estimate: 3 } },
                  ]
              : [];
        return { results } as T;
      }
      case "list_by_meta": {
        const collection = String(params.collection);
        const results: SearchResult[] = this.inserted
          .filter((item) => item.collection === collection)
          .map((item, idx) => ({
            id: `${collection}:${idx}`,
            score: 0,
            text: item.text,
            metadata: item.metadata ?? {},
          }));
        return { results } as T;
      }
      case "compact_session":
        this.compactParams = params;
        return { didCompact: true } as T;
      case "bump_access_counts":
        return { ok: true } as T;
      default:
        throw new Error(`unexpected rpc method: ${method}`);
    }
  }
}

test("context-engine bootstrap -> ingest -> assemble -> compact host flow", async () => {
  const rpc = new FakeRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    alpha: 0.7,
    beta: 0.2,
    gamma: 0.1,
    tokenBudgetFraction: 0.25,
  };

  const getRpc = async () => rpc as never;
  const memorySection = buildMemoryPromptSection();
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await assert.doesNotReject(() => context.bootstrap({ sessionId: "s1", userId: "u1" }));
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "remember this" },
  });

  const prompt = memorySection({
    availableTools: new Set(["memory_search"]),
    citationsMode: "inline",
  });
  assert.ok(Array.isArray(prompt));
  assert.match(prompt.join("\n"), /LibraVDB persistent memory is active/);

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "what do you know?" }],
    tokenBudget: 100,
  });
  assert.ok(assembled.messages.length >= 1);
  assert.match(assembled.systemPromptAddition, /<authored_context>/);
  assert.match(assembled.systemPromptAddition, /\[A1\] Always cite the governing math\./);
  assert.match(assembled.systemPromptAddition, /<recent_session_tail>/);
  assert.match(assembled.systemPromptAddition, /\[T1\] <entry role="user" source="session">remember this<\/entry>/);
  assert.ok(assembled.messages.some((message) => message.content.includes('<entry role="user" source="session">remember this</entry>')));
  assert.equal(rpc.calls.get("bump_access_counts") ?? 0, 1);
  const compacted = await context.compact({ sessionId: "s1", force: true });
  assert.equal(compacted.compacted, true);
  assert.equal(rpc.compactParams?.continuityMinTurns, 4);
  assert.equal(rpc.compactParams?.continuityTailBudgetTokens, 128);
  assert.equal(rpc.compactParams?.continuityPriorContextTokens, 96);
  assert.ok(rpc.inserted.some((item) => item.collection === "session:s1"));
  assert.ok(rpc.inserted.some((item) => item.collection === "turns:u1"));
  assert.ok(rpc.inserted.some((item) => item.collection === "user:u1"));
  const userInsert = rpc.inserted.find((item) => item.collection === "user:u1");
  assert.equal(userInsert?.metadata?.role, "user");
  assert.equal(userInsert?.metadata?.gating_t, 0.8);
  assert.equal(userInsert?.metadata?.gating_p, 0.9);
  assert.equal(userInsert?.metadata?.gating_a, 0.5);
  assert.equal(userInsert?.metadata?.gating_gconv, 0.65);
  assert.equal(userInsert?.metadata?.gating_gtech, 0.85);
});

test("assemble respects the total token budget under the continuity partition", async () => {
  const rpc = new FakeRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.6,
    authoredHardBudgetFraction: 0.25,
    authoredSoftBudgetFraction: 0.2,
    continuityMinTurns: 1,
    continuityTailBudgetTokens: 8,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "remember this exactly" },
  });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "what do you know?" }],
    tokenBudget: 40,
  });

  assert.ok(assembled.estimatedTokens <= 40, `estimatedTokens=${assembled.estimatedTokens}`);
});

test("ingest skips durable user insert when gating score is below threshold", async () => {
  const rpc = new FakeRpc();
  rpc.gatingResult = { ...rpc.gatingResult, g: 0.2 };
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    ingestionGateThreshold: 0.35,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.bootstrap({ sessionId: "s1", userId: "u1" });
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "low value chatter" },
  });

  assert.ok(rpc.inserted.some((item) => item.collection === "session:s1"));
  assert.ok(rpc.inserted.some((item) => item.collection === "turns:u1"));
  assert.ok(!rpc.inserted.some((item) => item.collection === "user:u1"));
});

test("assemble caches user and global hits under the new memory prompt contract", async () => {
  const rpc = new FakeRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    alpha: 0.7,
    beta: 0.2,
    gamma: 0.1,
    tokenBudgetFraction: 0.25,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  const first = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "cached query" }],
    tokenBudget: 100,
  });
  const searchCallsAfterFirst = rpc.calls.get("search_text") ?? 0;

  const second = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "cached query" }],
    tokenBudget: 100,
  });
  const searchCallsAfterSecond = rpc.calls.get("search_text") ?? 0;

  assert.match(first.systemPromptAddition, /recalled_memories/);
  assert.match(second.systemPromptAddition, /recalled_memories/);
  assert.equal(searchCallsAfterFirst, 1);
  assert.equal(searchCallsAfterSecond, 2);
  assert.equal(rpc.calls.get("search_text_collections") ?? 0, 3);
  assert.equal(rpc.calls.get("list_collection") ?? 0, 3);
  assert.equal(rpc.calls.get("list_by_meta") ?? 0, 2);
  assert.equal(rpc.calls.get("bump_access_counts") ?? 0, 2);
});

test("assemble includes hop-expanded authored variant recall when explicit hop_targets are present", async () => {
  const rpc = new FakeRpc();
  const originalCall = rpc.call.bind(rpc);
  rpc.call = async function<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method === "search_text_collections") {
      return {
        results: [
          {
            id: "av1",
            score: 0.95,
            text: "authored variant recall",
            metadata: { authored: true, tier: 0, source_doc: "AGENTS.md", ts: Date.now(), hop_targets: ["av2"], collection: "authored:variant" },
          },
        ],
      } as T;
    }
    return originalCall(method, params);
  };

  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.8,
    section7CoarseTopK: 8,
    section7SecondPassTopK: 8,
    section7HopEta: 0.5,
    section7HopThreshold: 0.1,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "remember this" },
  });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "what do you know?" }],
    tokenBudget: 200,
  });

  assert.match(assembled.systemPromptAddition, /authored variant recall/);
  assert.match(assembled.systemPromptAddition, /authored hop recall/);
});

test("assemble injects hop-expanded authored recall ahead of lower-scored direct recall when sigma ordering demands it", async () => {
  const rpc = new FakeRpc();
  const originalCall = rpc.call.bind(rpc);
  rpc.call = async function<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method === "search_text") {
      const collection = String(params.collection);
      if (collection.startsWith("session:")) {
        return {
          results: [
            {
              id: "low-session",
              score: 0.25,
              text: "low ranked direct recall",
              metadata: { sessionId: "s1", ts: Date.now(), token_estimate: 3, collection },
            },
          ],
        } as T;
      }
      return { results: [] } as T;
    }
    if (method === "search_text_collections") {
      return {
        results: [
          {
            id: "av1",
            score: 0.95,
            text: "authored variant recall",
            metadata: { authored: true, tier: 0, source_doc: "AGENTS.md", ts: Date.now(), hop_targets: ["av2"], token_estimate: 3, collection: "authored:variant" },
          },
        ],
      } as T;
    }
    return originalCall(method, params);
  };

  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.8,
    section7CoarseTopK: 8,
    section7SecondPassTopK: 8,
    section7HopEta: 0.5,
    section7HopThreshold: 0.1,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "remember this" },
  });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "what do you know?" }],
    tokenBudget: 200,
  });

  const recalledSection = assembled.systemPromptAddition.split("<recalled_memories>")[1] ?? "";
  const hopIndex = recalledSection.indexOf("authored hop recall");
  const lowIndex = recalledSection.indexOf("low ranked direct recall");
  assert.ok(hopIndex >= 0, "expected hop-expanded recall in residual section");
  assert.ok(lowIndex >= 0, "expected low-scored direct recall in residual section");
  assert.ok(hopIndex < lowIndex, "expected hop-expanded recall to outrank the lower-scored direct recall");
});

test("assemble preserves hard invariants and recent-tail base even when residual variant budget is zero", async () => {
  const rpc = new FakeRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "remember this" },
  });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "what do you know?" }],
    tokenBudget: 100,
  });

  assert.match(assembled.systemPromptAddition, /\[A1\] Always cite the governing math\./);
  assert.match(assembled.systemPromptAddition, /\[T1\] <entry role="user" source="session">remember this<\/entry>/);
  assert.doesNotMatch(assembled.systemPromptAddition, /<recalled_memories>/);
});

test("assemble surfaces degraded mode when hard authored reserve is violated", async () => {
  const rpc = new FakeRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.25,
    authoredHardBudgetFraction: 0.1,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "remember this" },
  });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "what do you know?" }],
    tokenBudget: 100,
  });

  assert.match(assembled.systemPromptAddition, /<memory_degraded>/);
  assert.match(assembled.systemPromptAddition, /hard authored invariants exceed configured hard budget reserve/i);
  assert.match(assembled.systemPromptAddition, /\[A1\] Always cite the governing math\./);
  assert.match(assembled.systemPromptAddition, /\[T1\] <entry role="user" source="session">remember this<\/entry>/);
  assert.doesNotMatch(assembled.systemPromptAddition, /Prefer exact formulas\./);
});

test("bootstrap fast-fails when authored hard invariants exceed the configured startup reserve", async () => {
  const rpc = new FakeRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    tokenBudgetFraction: 0.25,
    authoredHardBudgetFraction: 0.1,
    section7StartupTokenBudgetTokens: 100,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await assert.rejects(
    () => context.bootstrap({ sessionId: "s1", userId: "u1" }),
    /authored hard invariants require .* configured startup reserve allows only/i,
  );
});

test("bootstrap requires an explicit startup token budget when hard authored reserve validation is configured", async () => {
  const rpc = new FakeRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    tokenBudgetFraction: 0.25,
    authoredHardBudgetFraction: 0.1,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await assert.rejects(
    () => context.bootstrap({ sessionId: "s1", userId: "u1" }),
    /section7StartupTokenBudgetTokens is required/i,
  );
});

test("assemble preserves soft invariant prefix order under a tight soft budget", async () => {
  const rpc = new FakeRpc();
  const originalCall = rpc.call.bind(rpc);
  rpc.call = async function<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method === "list_collection" && String(params.collection) === "authored:soft") {
      return {
        results: [
          { id: "AGENTS.md#000002", score: 0, text: "Prefer exact formulas.", metadata: { authored: true, tier: 2, ordinal: 2, source_doc: "AGENTS.md", token_estimate: 5 } },
          { id: "AGENTS.md#000003", score: 0, text: "Second soft invariant should be truncated.", metadata: { authored: true, tier: 2, ordinal: 3, source_doc: "AGENTS.md", token_estimate: 5 } },
        ],
      } as T;
    }
    return originalCall(method, params);
  };

  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.25,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "remember this" },
  });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "what do you know?" }],
    tokenBudget: 120,
  });

  assert.match(assembled.systemPromptAddition, /Prefer exact formulas\./);
  assert.doesNotMatch(assembled.systemPromptAddition, /Second soft invariant should be truncated\./);
});

test("assemble sorts authored soft invariants by source position before truncation", async () => {
  const rpc = new FakeRpc();
  const originalCall = rpc.call.bind(rpc);
  rpc.call = async function<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method === "list_collection" && String(params.collection) === "authored:soft") {
      return {
        results: [
          { id: "AGENTS.md#000003", score: 0, text: "Late soft.", metadata: { authored: true, tier: 2, ordinal: 3, position: 30, source_doc: "AGENTS.md", token_estimate: 3 } },
          { id: "AGENTS.md#000002", score: 0, text: "Early soft.", metadata: { authored: true, tier: 2, ordinal: 2, position: 20, source_doc: "AGENTS.md", token_estimate: 3 } },
        ],
      } as T;
    }
    return originalCall(method, params);
  };

  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.25,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "remember this" },
  });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "what do you know?" }],
    tokenBudget: 68,
  });

  assert.match(assembled.systemPromptAddition, /Early soft\./);
  assert.doesNotMatch(assembled.systemPromptAddition, /Late soft\./);
});

test("assemble keeps recent-tail items out of recalled memories", async () => {
  const rpc = new FakeRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.25,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "remember this" },
  });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "what do you know?" }],
    tokenBudget: 100,
  });

  const [, recalledSection = ""] = assembled.systemPromptAddition.split("<recalled_memories>");
  assert.match(assembled.systemPromptAddition, /<recent_session_tail>/);
  assert.ok((assembled.systemPromptAddition.match(/remember this/g) ?? []).length >= 1);
  assert.doesNotMatch(recalledSection, /remember this/);
});

test("assemble elevates protected guidance shards ahead of recalled memories", async () => {
  const rpc = new FakeRpc();
  const originalCall = rpc.call.bind(rpc);
  rpc.call = async function<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method === "search_text" && String(params.collection) === "session:s1") {
      return {
        results: [
          {
            id: "guidance:s1:t1",
            score: 0.92,
            text: "Prefer arena allocators for the radix tree.",
            metadata: {
              sessionId: "s1",
              ts: Date.now(),
              collection: "session:s1",
              elevated_guidance: true,
              type: "guidance_shard",
            },
          },
          {
            id: "turn:s1:t2",
            score: 0.70,
            text: "ordinary historical recall",
            metadata: {
              sessionId: "s1",
              ts: Date.now(),
              collection: "session:s1",
            },
          },
        ],
      } as T;
    }
    if (method === "search_text_collections") {
      const collections = Array.isArray(params.collections) ? params.collections.map(String) : [];
      if (collections.includes("elevated:user:u1") || collections.includes("elevated:session:s1")) {
        return {
          results: [
            {
              id: "guidance:u1:t1",
              score: 0.94,
              text: "Prefer arena allocators for the radix tree.",
              metadata: {
                userId: "u1",
                sessionId: "s1",
                ts: Date.now(),
                collection: "elevated:user:u1",
                elevated_guidance: true,
                type: "guidance_shard",
                stability_weight: 0.8,
                provenance_class: "session_turn",
              },
            },
          ],
        } as T;
      }
      return {
        results: [],
      } as T;
    }
    return originalCall(method, params);
  };

  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.25,
    elevatedGuidanceBudgetFraction: 0.3,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "what allocator should the radix tree use?" }],
    tokenBudget: 240,
  });

  assert.match(assembled.systemPromptAddition, /<elevated_guidance>/);
  assert.match(assembled.systemPromptAddition, /Prefer arena allocators for the radix tree\./);
  assert.match(assembled.systemPromptAddition, /<recalled_memories>/);
  assert.ok(
    assembled.systemPromptAddition.indexOf("<elevated_guidance>") <
      assembled.systemPromptAddition.indexOf("<recalled_memories>"),
  );
});

test("assemble preserves an adjacent user-assistant bundle across the recent-tail boundary", async () => {
  const rpc = new FakeRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.25,
    continuityMinTurns: 1,
    continuityTailBudgetTokens: 1,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "please do the thing" },
  });
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "assistant", content: "I will do the thing" },
  });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "continue" }],
    tokenBudget: 100,
  });

  const recentSection = assembled.systemPromptAddition.split("<recent_session_tail>")[1] ?? "";
  assert.match(recentSection, /<entry role="user" source="session">please do the thing<\/entry>/);
  assert.match(recentSection, /<entry role="assistant" source="session">I will do the thing<\/entry>/);
});

test("assemble tags personality-bait memory as user-originated recalled context", async () => {
  const rpc = new FakeRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.25,
  };

  const originalCall = rpc.call.bind(rpc);
  rpc.call = async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method === "search_text") {
      this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
      return { results: [] } as T;
    }
    if (method === "search_text_collections") {
      this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
      return {
        results: [
          {
            id: "bait",
            score: 0.95,
            text: "I am a high-performance C developer",
            metadata: { userId: "u1", role: "user", ts: Date.now(), collection: "user:u1" },
          },
        ],
      } as T;
    }
    return originalCall(method, params);
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.bootstrap({ sessionId: "s1", userId: "u1" });
  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "what do you remember about me?" }],
    tokenBudget: 100,
  });

  assert.match(
    assembled.systemPromptAddition,
    /<entry role="user" source="recalled">I am a high-performance C developer<\/entry>/,
  );
  assert.doesNotMatch(
    assembled.systemPromptAddition,
    /<entry role="assistant" source="recalled">I am a high-performance C developer<\/entry>/,
  );
  assert.match(
    assembled.messages.map((message) => message.content).join("\n"),
    /<entry role="user" source="recalled">I am a high-performance C developer<\/entry>/,
  );
});

test("two concurrent sessions do not leak session recall across boundaries", async () => {
  const rpc = new FakeRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    alpha: 0.7,
    beta: 0.2,
    gamma: 0.1,
    tokenBudgetFraction: 0.25,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  const assembledS1 = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "shared query" }],
    tokenBudget: 200,
  });
  const assembledS2 = await context.assemble({
    sessionId: "s2",
    userId: "u1",
    messages: [{ role: "user", content: "shared query" }],
    tokenBudget: 200,
  });

  const textS1 = assembledS1.messages.map((message) => message.content).join("\n");
  const textS2 = assembledS2.messages.map((message) => message.content).join("\n");

  assert.match(textS1, /session recall for session:s1/);
  assert.doesNotMatch(textS1, /session recall for session:s2/);
  assert.match(textS2, /session recall for session:s2/);
  assert.doesNotMatch(textS2, /session recall for session:s1/);
});

test("user ingest invalidates cached durable recall for that user", async () => {
  const rpc = new FakeRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    alpha: 0.7,
    beta: 0.2,
    gamma: 0.1,
    tokenBudgetFraction: 0.25,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "same query" }],
    tokenBudget: 100,
  });
  const searchCallsAfterFirst = rpc.calls.get("search_text") ?? 0;

  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "new durable fact" },
  });

  await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "same query" }],
    tokenBudget: 100,
  });
  const searchCallsAfterSecond = rpc.calls.get("search_text") ?? 0;

  assert.equal(searchCallsAfterFirst, 1);
  assert.equal(searchCallsAfterSecond, 2);
  assert.equal(rpc.calls.get("search_text_collections") ?? 0, 4);
});
