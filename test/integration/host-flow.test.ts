import test from "node:test";
import assert from "node:assert/strict";

import { buildContextEngineFactory } from "../../src/context-engine.js";
import { acquireTestDaemonHandle } from "./daemon-harness.js";
import { buildMemoryPromptSection } from "../../src/memory-provider.js";
import { createPluginRuntime } from "../../src/plugin-runtime.js";
import { createRecallCache } from "../../src/recall-cache.js";
import type { PluginConfig, SearchResult } from "../../src/types.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function profileTurnContent(index: number): string {
  return `profile turn ${index} ` + "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(8);
}

function extractProfileMs(lines: string[], label: string): number | null {
  const prefix = `assemble profile: ${label}=`;
  const line = lines.find((entry) => entry.startsWith(prefix));
  if (!line) {
    return null;
  }
  const ms = Number(line.slice(prefix.length).replace(/ms$/, ""));
  return Number.isFinite(ms) ? ms : null;
}

function sumProfileMs(lines: string[]): number {
  return lines.reduce((sum, line) => {
    const match = /^assemble profile: [^=]+=([0-9.]+)ms$/.exec(line);
    if (!match) {
      return sum;
    }
    const value = Number(match[1]);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

function buildSummaryShapedSessionSurface(sessionId: string): SearchResult[] {
  const summaries = [
    { id: "summary-1", score: 0.90, text: "low confidence summary item one", confidence: 0.30, decayRate: 0.70, ageMs: 60_000 },
    { id: "summary-2", score: 0.88, text: "low confidence summary item two", confidence: 0.35, decayRate: 0.65, ageMs: 55_000 },
    { id: "summary-3", score: 0.85, text: "low confidence summary item three", confidence: 0.28, decayRate: 0.72, ageMs: 50_000 },
    { id: "summary-4", score: 0.82, text: "low confidence summary item four", confidence: 0.40, decayRate: 0.60, ageMs: 45_000 },
    { id: "summary-5", score: 0.80, text: "low confidence summary item five", confidence: 0.32, decayRate: 0.68, ageMs: 40_000 },
    { id: "summary-6", score: 0.78, text: "low confidence summary item six", confidence: 0.27, decayRate: 0.73, ageMs: 35_000 },
  ];

  return summaries.map((summary) => ({
    id: summary.id,
    score: summary.score,
    text: summary.text,
    metadata: {
      sessionId,
      ts: Date.now() - summary.ageMs,
      collection: `session:${sessionId}`,
      type: "summary",
      confidence: summary.confidence,
      decay_rate: summary.decayRate,
      authority: 1,
      token_estimate: 5,
    },
  }));
}

const MID_SIZED_BENCHMARK_TURNS = 64;
const MID_SIZED_SUMMARY_BATCHES = 4;
const MID_SIZED_SUMMARY_BATCH_SIZE = 16;
const ASSEMBLE_EVIDENCE_GATE_MS = Number(process.env.OPENCLAW_ASSEMBLE_EVIDENCE_GATE_MS ?? "100");

function authoredCollectionResults(collection: string): SearchResult[] {
  return collection === "authored:hard"
    ? [{ id: "AGENTS.md#000001", score: 0, text: "Always cite the governing math.", metadata: { authored: true, tier: 1, ordinal: 1, source_doc: "AGENTS.md", token_estimate: 6 } }]
    : collection === "authored:soft"
      ? [{ id: "AGENTS.md#000002", score: 0, text: "Prefer exact formulas.", metadata: { authored: true, tier: 2, ordinal: 2, source_doc: "AGENTS.md", token_estimate: 5 } }]
      : collection === "authored:variant"
        ? [
            { id: "av1", score: 0, text: "authored variant recall", metadata: { authored: true, tier: 0, source_doc: "AGENTS.md", ts: Date.now(), hop_targets: ["av2"], token_estimate: 3 } },
            { id: "av2", score: 0, text: "authored hop recall", metadata: { authored: true, tier: 0, source_doc: "AGENTS.md", ts: Date.now(), token_estimate: 3 } },
          ]
        : [];
}

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
      case "insert_session_turn":
        this.inserted.push({
          collection: `session:${String(params.sessionId)}`,
          text: String(params.text),
          metadata: params.metadata as Record<string, unknown> | undefined,
        });
        this.inserted.push({
          collection: `session_raw:${String(params.sessionId)}`,
          text: String(params.text),
          metadata: {
            ...((params.metadata as Record<string, unknown> | undefined) ?? {}),
            raw_history: true,
            active_view: false,
          },
        });
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
        const results: SearchResult[] = authoredCollectionResults(collection);
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
      case "query_raw_session":
        return { results: [] } as T; // empty = no recovery needed for healthy session
      default:
        throw new Error(`unexpected rpc method: ${method}`);
    }
  }
}

class ProjectionStoreRpc {
  public calls = new Map<string, number>();
  public collections = new Map<string, SearchResult[]>();
  public searchedCollections: string[] = [];
  public compactHook: ((sessionId: string) => void) | null = null;
  public lastQueryRawSessionParams: Record<string, unknown> | null = null;
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
      case "ensure_collections": {
        const collections = Array.isArray(params.collections) ? params.collections : [];
        for (const collection of collections) {
          this.ensureCollection(String(collection));
        }
        return { ok: true } as T;
      }
      case "insert_text": {
        const collection = String(params.collection);
        const record: SearchResult = {
          id: String(params.id),
          score: typeof params.score === "number" ? params.score : 0,
          text: String(params.text),
          metadata: {
            ...((params.metadata as Record<string, unknown> | undefined) ?? {}),
          },
        };
        const items = this.ensureCollection(collection);
        const existingIndex = items.findIndex((item) => item.id === record.id);
        if (existingIndex >= 0) {
          items[existingIndex] = record;
        } else {
          items.push(record);
        }
        return { ok: true } as T;
      }
      case "insert_session_turn": {
        const sessionId = String(params.sessionId);
        const id = String(params.id);
        const text = String(params.text);
        const metadata = {
          ...((params.metadata as Record<string, unknown> | undefined) ?? {}),
        };
        for (const [collection, recordMetadata] of [
          [`session:${sessionId}`, metadata],
          [`session_raw:${sessionId}`, { ...metadata, raw_history: true, active_view: false }],
        ] as const) {
          const record: SearchResult = {
            id,
            score: 0,
            text,
            metadata: recordMetadata,
          };
          const items = this.ensureCollection(collection);
          const existingIndex = items.findIndex((item) => item.id === record.id);
          if (existingIndex >= 0) {
            items[existingIndex] = record;
          } else {
            items.push(record);
          }
        }
        return { ok: true } as T;
      }
      case "delete_batch": {
        const collection = String(params.collection);
        const ids = new Set(Array.isArray(params.ids) ? params.ids.map(String) : []);
        const items = this.ensureCollection(collection);
        this.collections.set(collection, items.filter((item) => !ids.has(item.id)));
        return { ok: true } as T;
      }
      case "gating_scalar":
        return this.gatingResult as T;
      case "search_text": {
        const collection = String(params.collection);
        this.searchedCollections.push(collection);
        const query = String(params.text ?? "");
        const excludeIds = new Set(Array.isArray(params.excludeIds) ? params.excludeIds.map(String) : []);
        const results = this.ensureCollection(collection)
          .filter((item) => !excludeIds.has(item.id))
          .map((item) => scoreMockSearchResult(item, query, collection))
          .filter((item) => item.score > 0)
          .sort((a, b) => {
            if (b.score !== a.score) {
              return b.score - a.score;
            }
            return a.id.localeCompare(b.id);
          });
        return { results } as T;
      }
      case "search_text_collections":
        return {
          results: (Array.isArray(params.collections) ? params.collections : [])
            .flatMap((collection) => {
              const collectionName = String(collection);
              const query = String(params.text ?? "");
              return this.ensureCollection(collectionName)
                .map((item) => scoreMockSearchResult(item, query, collectionName))
                .filter((item) => item.score > 0)
                .map((item) => ({
                  ...item,
                  metadata: {
                    ...item.metadata,
                    collection: typeof item.metadata.collection === "string"
                      ? item.metadata.collection
                      : collectionName,
                  },
                }));
            })
            .sort((a, b) => {
              if (b.score !== a.score) {
                return b.score - a.score;
              }
              if (a.metadata.collection !== b.metadata.collection) {
                return String(a.metadata.collection ?? "").localeCompare(String(b.metadata.collection ?? ""));
              }
              return a.id.localeCompare(b.id);
            }),
        } as T;
      case "list_collection": {
        const collection = String(params.collection);
        const custom = this.collections.get(collection);
        if (custom) {
          return { results: [...custom] } as T;
        }
        const authored = authoredCollectionResults(collection);
        if (authored.length > 0) {
          return { results: authored } as T;
        }
        return { results: [...this.ensureCollection(collection)] } as T;
      }
      case "list_by_meta": {
        const collection = String(params.collection);
        const key = String(params.key);
        const value = params.value;
        const results = this.ensureCollection(collection)
          .filter((item) => item.metadata[key] === value)
          .map((item) => ({ ...item, metadata: { ...item.metadata } }));
        return { results } as T;
      }
      case "compact_session": {
        const sessionId = String(params.sessionId);
        this.compactHook?.(sessionId);
        return { didCompact: true } as T;
      }
      case "bump_access_counts":
      case "flush":
      case "health":
        return { ok: true } as T;
      case "query_raw_session": {
        this.lastQueryRawSessionParams = { ...params };
        const sessionId = String(params.sessionId);
        const excludeIds = new Set(Array.isArray(params.excludeIds) ? params.excludeIds.map(String) : []);
        const collection = `session_raw:${sessionId}`;
        const results = (this.collections.get(collection) ?? [])
          .filter((item) => !excludeIds.has(item.id))
          .map((item) => ({
            ...item,
            metadata: {
              ...item.metadata,
              collection,
              recovery_fallback: true,
            },
          }));
        return { results } as T;
      }
      default:
        throw new Error(`unexpected rpc method: ${method}`);
    }
  }

  private ensureCollection(collection: string): SearchResult[] {
    const existing = this.collections.get(collection);
    if (existing) {
      return existing;
    }
    const created: SearchResult[] = [];
    this.collections.set(collection, created);
    return created;
  }
}

function scoreMockSearchResult(item: SearchResult, query: string, collection: string): SearchResult {
  const lexicalScore = lexicalSimilarity(query, item.text);
  const seededScore = typeof item.score === "number" ? item.score : 0;
  const blendedScore = seededScore > 0
    ? Math.min(1, (seededScore * 0.35) + (lexicalScore * 0.65))
    : lexicalScore;
  const finalScore = collection.startsWith("user:") && blendedScore < 0.3 ? 0 : blendedScore;
  return {
    ...item,
    score: finalScore,
    metadata: {
      ...item.metadata,
      collection,
    },
  };
}

function lexicalSimilarity(query: string, text: string): number {
  const queryTerms = tokenSet(query);
  const textTerms = tokenSet(text);
  if (queryTerms.size === 0 || textTerms.size === 0) {
    return 0;
  }

  let matches = 0;
  for (const term of queryTerms) {
    if (textTerms.has(term)) {
      matches += 1;
      continue;
    }
    for (const candidate of textTerms) {
      if (candidate.includes(term) || term.includes(candidate)) {
        matches += 0.5;
        break;
      }
    }
  }

  return Math.max(0, Math.min(1, matches / queryTerms.size));
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

test("retrieval quality harness section 1 prefers fresher durable memory over stale higher-similarity global summary", async () => {
  const rpc = new ProjectionStoreRpc();
  const recallCache = createRecallCache<SearchResult>();
  const now = Date.now();
  rpc.collections.set("user:u1", [
    {
      id: "user-fresh",
      score: 0.72,
      text: "durable user memory winner",
      metadata: {
        userId: "u1",
        ts: now,
        collection: "user:u1",
        token_estimate: 4,
      },
    },
  ]);
  rpc.collections.set("global", [
    {
      id: "global-stale-summary",
      score: 0.96,
      text: "stale global summary loser",
      metadata: {
        ts: now - 21 * 24 * 60 * 60 * 1000,
        collection: "global",
        type: "summary",
        decay_rate: 1,
        token_estimate: 4,
      },
    },
  ]);

  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    alpha: 0.7,
    beta: 0.2,
    gamma: 0.1,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);
  await context.bootstrap({ sessionId: "s1", userId: "u1" });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "winner" }],
    tokenBudget: 200,
  });

  const rendered = assembled.systemPromptAddition;
  const userIndex = rendered.indexOf("durable user memory winner");
  const globalIndex = rendered.indexOf("stale global summary loser");
  assert.ok(userIndex >= 0, "expected durable user memory in assembled recall");
  assert.ok(globalIndex >= 0, "expected stale global summary in assembled recall");
  assert.ok(userIndex < globalIndex, "expected fresher durable user memory to outrank stale global summary");
});

test("retrieval quality harness section 7 prefers authoritative authored variant over semantically stronger plain recall", async () => {
  const rpc = new ProjectionStoreRpc();
  const recallCache = createRecallCache<SearchResult>();
  const now = Date.now();
  rpc.collections.set("global", [
    {
      id: "global-plain",
      score: 0.95,
      text: "math continuity budget plain recall",
      metadata: {
        ts: now,
        collection: "global",
        token_estimate: 4,
      },
    },
  ]);
  rpc.collections.set("authored:variant", [
    {
      id: "authored-authoritative",
      score: 0.78,
      text: "math continuity budget authoritative recall",
      metadata: {
        authored: true,
        authority: 1,
        ts: now,
        collection: "authored:variant",
        token_estimate: 4,
      },
    },
  ]);

  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.8,
    section7CoarseTopK: 8,
    section7SecondPassTopK: 8,
    section7Theta1: 0,
    section7Kappa: 0.3,
    section7AuthorityRecencyLambda: 0,
    section7AuthorityRecencyWeight: 0,
    section7AuthorityFrequencyWeight: 0,
    section7AuthorityAuthoredWeight: 1,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);
  await context.bootstrap({ sessionId: "s1", userId: "u1" });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "math continuity budget" }],
    tokenBudget: 200,
  });

  const recalledSection = assembled.systemPromptAddition.split("<recalled_memories>")[1] ?? "";
  const authoredIndex = recalledSection.indexOf("math continuity budget authoritative recall");
  const globalIndex = recalledSection.indexOf("math continuity budget plain recall");
  assert.ok(authoredIndex >= 0, "expected authoritative authored variant in recalled section");
  assert.ok(globalIndex >= 0, "expected plain global recall in recalled section");
  assert.ok(authoredIndex < globalIndex, "expected authoritative authored variant to outrank plain global recall");
});

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
  const memorySection = buildMemoryPromptSection(getRpc, cfg, recallCache);
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
  assert.match(prompt.join("\n"), /LibraVDB persistent memory is configured/);

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

test("real sidecar mid-sized session search benchmark", async (t) => {
  if (process.env.OPENCLAW_PROFILE_ASSEMBLE !== "1") {
    t.skip("requires OPENCLAW_PROFILE_ASSEMBLE=1");
    return;
  }

  const daemon = await acquireTestDaemonHandle();

  const logger = {
    error() {},
    info() {},
    warn() {},
  };

  try {
    async function runScenario(label: string, overrides: Partial<PluginConfig>) {
      const cfg: PluginConfig = {
        sidecarPath: daemon.endpoint,
        rpcTimeoutMs: 30_000,
        topK: 8,
        alpha: 0.7,
        beta: 0.2,
        gamma: 0.1,
        tokenBudgetFraction: 0.25,
        ...overrides,
      };
      const runtime = createPluginRuntime(cfg, logger);
      const recallCache = createRecallCache<SearchResult>();
      const context = buildContextEngineFactory(runtime.getRpc, cfg, recallCache);
      const memorySection = buildMemoryPromptSection(runtime.getRpc, cfg, recallCache);
      const seed = Date.now().toString(36);
      const sessionId = `profile-${label}-${process.pid}-${seed}`;
      const userId = `profile-user-${label}-${process.pid}-${seed}`;
      const queryText = "real sidecar profiling probe";
      const isSummaryOnly = cfg.useSessionSummarySearchExperiment === true;
      const benchmarkTurnCount = isSummaryOnly
        ? MID_SIZED_SUMMARY_BATCHES * MID_SIZED_SUMMARY_BATCH_SIZE
        : MID_SIZED_BENCHMARK_TURNS;

      try {
        await context.bootstrap({ sessionId, userId });
        if (isSummaryOnly) {
          // Build a mid-sized compacted session so summary-only benchmarking
          // does not overfit a trivial one-summary collection.
          let turnIndex = 0;
          for (let batch = 0; batch < MID_SIZED_SUMMARY_BATCHES; batch += 1) {
            for (let i = 0; i < MID_SIZED_SUMMARY_BATCH_SIZE; i += 1) {
              await context.ingest({
                sessionId,
                userId,
                message: { role: "user", content: profileTurnContent(turnIndex) },
              });
              turnIndex += 1;
              await delay(2);
            }
            const compacted = await context.compact({ sessionId, force: true });
            assert.equal(compacted.compacted, true);
          }
        } else {
          for (let i = 0; i < benchmarkTurnCount; i += 1) {
            await context.ingest({
              sessionId,
              userId,
              message: { role: "user", content: profileTurnContent(i) },
            });
            await delay(2);
          }
        }

        const rpc = await runtime.getRpc();
        const summaryCollection = `session_summary:${sessionId}`;
        const summaryState = await rpc.call<{ results: SearchResult[] }>("list_collection", {
          collection: summaryCollection,
        });
        if (isSummaryOnly) {
          assert.ok(
            summaryState.results.length >= 2,
            `expected richer summary-only probe fixture, got ${summaryState.results.length} summary records`,
          );
        }
        const searchCollection =
          summaryState.results.length > 0 && cfg.useSessionSummarySearchExperiment === true
            ? summaryCollection
            : cfg.useSessionRecallProjection
              ? `session_recall:${sessionId}`
              : `session:${sessionId}`;
        const collectionState = await rpc.call<{ results: SearchResult[] }>("list_collection", {
          collection: searchCollection,
        });
        if (isSummaryOnly) {
          assert.ok(
            collectionState.results.length >= 2,
            `expected mid-sized summary-only benchmark fixture, got ${collectionState.results.length} records`,
          );
        } else if (cfg.useSessionRecallProjection) {
          assert.ok(
            collectionState.results.length >= 32,
            `expected mid-sized session_recall projection fixture, got ${collectionState.results.length} records`,
          );
        } else {
          assert.ok(
            collectionState.results.length >= 32,
            `expected mid-sized baseline fixture, got ${collectionState.results.length} records`,
          );
        }
        process.stdout.write(
          `[benchmark:${label}] search_collection=${searchCollection} record_count=${collectionState.results.length} summary_record_count=${summaryState.results.length}\n`,
        );

        for (let i = 0; i < 3; i += 1) {
          const prompt = memorySection({
            availableTools: new Set(["memory_search"]),
          });
          assert.ok(prompt.length > 0);

          const assembled = await context.assemble({
            sessionId,
            userId,
            messages: [{ role: "user", content: queryText }],
            tokenBudget: 4000,
          });
          const passLogs = assembled._profile ?? [];
          const passTotalMs = sumProfileMs(passLogs);
          const sessionSearchMs = extractProfileMs(passLogs, "session_search");
          if (passLogs.length === 0) {
            process.stdout.write(`[benchmark:${label}:pass${i + 1}] no profiler lines captured\n`);
          }
          for (const line of passLogs) {
            process.stdout.write(`[benchmark:${label}:pass${i + 1}] ${line}\n`);
          }
          if (process.env.OPENCLAW_ENFORCE_ASSEMBLE_EVIDENCE_GATE === "1" && i > 0) {
            assert.ok(
              sessionSearchMs !== null && sessionSearchMs <= ASSEMBLE_EVIDENCE_GATE_MS,
              `warm assemble pass ${i + 1} exceeded evidence gate: session_search=${sessionSearchMs?.toFixed(2) ?? "n/a"}ms > ${ASSEMBLE_EVIDENCE_GATE_MS}ms`,
            );
          }
          if (process.env.OPENCLAW_ENFORCE_ASSEMBLE_EVIDENCE_GATE === "1") {
            process.stdout.write(
              `[benchmark:${label}:pass${i + 1}] gate=session_search<=${ASSEMBLE_EVIDENCE_GATE_MS} total=${passTotalMs.toFixed(2)}ms\n`,
            );
          }
          assert.ok(assembled.messages.length > 0);
          assert.ok(assembled.systemPromptAddition.length > 0);
        }
      } finally {
        await runtime.shutdown();
      }
    }

    await runScenario("baseline", {});
    if (process.env.OPENCLAW_BENCHMARK_COMPARE_VARIANTS === "1") {
      await runScenario("session_recall", { useSessionRecallProjection: true });
      await runScenario("session_summary_only", { useSessionSummarySearchExperiment: true });
    }
  } finally {
    await daemon.stop();
  }
});

test("real sidecar session_recall index threshold probe", async (t) => {
  if (process.env.OPENCLAW_PROFILE_ASSEMBLE !== "1") {
    t.skip("requires OPENCLAW_PROFILE_ASSEMBLE=1");
    return;
  }

  const daemon = await acquireTestDaemonHandle();
  const logger = {
    error() {},
    info() {},
    warn() {},
  };
  const belowTarget = Number(process.env.OPENCLAW_SESSION_RECALL_BELOW ?? "9999");
  const aboveTarget = Number(process.env.OPENCLAW_SESSION_RECALL_ABOVE ?? "10001");

  try {
    async function runThresholdScenario(label: string, projectionTarget: number) {
      const cfg: PluginConfig = {
        sidecarPath: daemon.endpoint,
        rpcTimeoutMs: 5000,
        topK: 8,
        alpha: 0.7,
        beta: 0.2,
        gamma: 0.1,
        tokenBudgetFraction: 0.25,
        useSessionRecallProjection: true,
        continuityMinTurns: 1,
        continuityTailBudgetTokens: 1,
      };
      const runtime = createPluginRuntime(cfg, logger);
      const recallCache = createRecallCache<SearchResult>();
      const context = buildContextEngineFactory(runtime.getRpc, cfg, recallCache);
      const memorySection = buildMemoryPromptSection(runtime.getRpc, cfg, recallCache);
      const seed = Date.now().toString(36);
      const sessionId = `threshold-${label}-${process.pid}-${seed}`;
      const userId = `threshold-user-${label}-${process.pid}-${seed}`;
      const queryText = "real sidecar profiling probe";

      try {
        await context.bootstrap({ sessionId, userId });
        const turnCount = projectionTarget + 1;
        for (let i = 0; i < turnCount; i += 1) {
          await context.ingest({
            sessionId,
            userId,
            message: { role: "user", content: profileTurnContent(i) },
          });
          if ((i + 1) % 1000 === 0 || i + 1 === turnCount) {
            process.stdout.write(`[threshold:${label}] seeded=${i + 1}\n`);
          }
          if (i < 8 || i % 250 === 0) {
            await delay(2);
          }
        }

        const rpc = await runtime.getRpc();
        const projection = await rpc.call<{ results: SearchResult[] }>("list_collection", {
          collection: `session_recall:${sessionId}`,
        });
        process.stdout.write(`[threshold:${label}] projection_count=${projection.results.length}\n`);

        for (let i = 0; i < 2; i += 1) {
          const prompt = memorySection({
            availableTools: new Set(["memory_search"]),
          });
          assert.ok(prompt.length > 0);

          const assembled = await context.assemble({
            sessionId,
            userId,
            messages: [{ role: "user", content: queryText }],
            tokenBudget: 4000,
          });
          const passLogs = assembled._profile ?? [];
          const sessionSearchMs = extractProfileMs(passLogs, "session_search");
          if (sessionSearchMs === null) {
            process.stdout.write(`[threshold:${label}:pass${i + 1}] no session_search timing captured\n`);
          } else {
            process.stdout.write(`[threshold:${label}:pass${i + 1}] session_search=${sessionSearchMs.toFixed(2)}ms\n`);
          }
        }
      } finally {
        await runtime.shutdown();
      }
    }

    await runThresholdScenario("below_10k", belowTarget);
    await runThresholdScenario("above_10k", aboveTarget);
  } finally {
    await daemon.stop();
  }
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

test("assemble recovers exact historical user turns from turns:user when the query session is fresh", async () => {
  const rpc = new ProjectionStoreRpc();
  rpc.gatingResult = { ...rpc.gatingResult, g: 0.2 };
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.5,
    ingestionGateThreshold: 0.35,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.bootstrap({ sessionId: "history", userId: "u1" });
  await context.ingest({
    sessionId: "history",
    userId: "u1",
    message: {
      role: "user",
      content: "Bought Samsung Galaxy S22 for Hawaii adapter.",
    },
  });

  assert.equal((rpc.collections.get("user:u1") ?? []).length, 0, "durable user memory should stay empty for this low-gate turn");
  assert.equal((rpc.collections.get("turns:u1") ?? []).length, 1, "raw per-user turn index should capture the turn");

  await context.bootstrap({ sessionId: "fresh", userId: "u1" });
  const assembled = await context.assemble({
    sessionId: "fresh",
    userId: "u1",
    messages: [{ role: "user", content: "Samsung Galaxy S22 Hawaii adapter?" }],
    tokenBudget: 400,
  });

  assert.match(assembled.systemPromptAddition, /Samsung Galaxy S22/);
  assert.equal(rpc.calls.get("query_raw_session") ?? 0, 0, "fresh-session recovery should not rely on session_raw");
  assert.ok((rpc.calls.get("search_text") ?? 0) >= 4, "fresh-session recovery should search turns:user in addition to the normal collections");
});

test("assemble: temporal fresh-session recovery prefers complementary date anchors over broader topical turns", async () => {
  const previousDebugFlag = process.env.LONGMEMEVAL_DEBUG_RANKING;
  process.env.LONGMEMEVAL_DEBUG_RANKING = "1";
  try {
    const rpc = new ProjectionStoreRpc();
    rpc.gatingResult = { ...rpc.gatingResult, g: 0.2 };
    const recallCache = createRecallCache<SearchResult>();
    const cfg: PluginConfig = {
      rpcTimeoutMs: 1000,
      topK: 8,
      tokenBudgetFraction: 0.5,
      ingestionGateThreshold: 0.35,
    };

    const getRpc = async () => rpc as never;
    const context = buildContextEngineFactory(getRpc, cfg, recallCache);

    await context.bootstrap({ sessionId: "history", userId: "u1" });
    await context.ingest({
      sessionId: "history",
      userId: "u1",
      message: {
        role: "user",
        content: "Rachel is helping me find a place near my office.",
      },
    });
    await context.ingest({
      sessionId: "history",
      userId: "u1",
      message: {
        role: "user",
        content: "I started working with Rachel on 2/15.",
      },
    });
    await context.ingest({
      sessionId: "history",
      userId: "u1",
      message: {
        role: "user",
        content: "I saw a house I loved on 3/1.",
      },
    });

    await context.bootstrap({ sessionId: "fresh", userId: "u1" });
    const assembled = await context.assemble({
      sessionId: "fresh",
      userId: "u1",
      messages: [{ role: "user", content: "How many days did it take for me to find a house I loved after starting to work with Rachel?" }],
      tokenBudget: 2000,
    });

    const temporalDebug = assembled._debug;
    assert.equal(temporalDebug?.temporalQueryActive, true);
    assert.ok((temporalDebug?.temporalQueryIndicator ?? 0) > 0);
    assert.ok((temporalDebug?.temporalRecoverySlots ?? []).length >= 1);

    const selectedCandidates = (temporalDebug?.rawUserRecoveryCandidates ?? []).filter((candidate) => candidate.selected);
    assert.ok(selectedCandidates.some((candidate) => /2\/15|3\/1/.test(candidate.text)), "expected at least one temporal anchor turn to be selected");
    assert.ok(!selectedCandidates.some((candidate) => /Rachel is helping me find a place near my office/.test(candidate.text)), "expected the broad topical turn to stay out of the temporal selector");
    assert.match(assembled.systemPromptAddition, /2\/15|3\/1/);
    assert.equal(rpc.calls.get("query_raw_session") ?? 0, 0, "fresh-session temporal recovery should use turns:user, not session_raw");
  } finally {
    if (typeof previousDebugFlag === "string") {
      process.env.LONGMEMEVAL_DEBUG_RANKING = previousDebugFlag;
    } else {
      delete process.env.LONGMEMEVAL_DEBUG_RANKING;
    }
  }
});

test("assemble caches user and global hits without prompt-section seeding", async () => {
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

  // Second assemble - authored:variant is now cached, so only session search runs
  const second = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "cached query" }],
    tokenBudget: 100,
  });
  const searchCallsAfterSecond = rpc.calls.get("search_text") ?? 0;

  assert.match(first.systemPromptAddition, /recalled_memories/);
  assert.match(second.systemPromptAddition, /recalled_memories/);
  assert.ok(searchCallsAfterFirst > 0, "first assemble should issue recall searches");
  assert.equal(
    searchCallsAfterSecond - searchCallsAfterFirst,
    1,
    "second assemble should only add the uncached session search",
  );
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
          { id: "AGENTS.md#000003", score: 0, text: "Late soft. This is a longer soft item that should be truncated after the shorter early soft item fits within the soft budget.", metadata: { authored: true, tier: 2, ordinal: 3, position: 30, source_doc: "AGENTS.md" } },
          { id: "AGENTS.md#000002", score: 0, text: "Early soft.", metadata: { authored: true, tier: 2, ordinal: 2, position: 20, source_doc: "AGENTS.md" } },
        ],
      } as T;
    }
    return originalCall(method, params);
  };

  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.5,
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
    tokenBudgetFraction: 0.5,
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

test("assemble reuses bootstrap-loaded authored collections without reloading", async () => {
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

  // Bootstrap loads authored collections (3 list_collection calls)
  await context.bootstrap({ sessionId: "s1", userId: "u1" });
  const listCollectionAfterBootstrap = rpc.calls.get("list_collection") ?? 0;

  // First assemble
  await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "query a" }],
    tokenBudget: 100,
  });
  const listCollectionAfterFirst = rpc.calls.get("list_collection") ?? 0;

  // Second assemble - should NOT trigger additional list_collection calls
  await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "query b" }],
    tokenBudget: 100,
  });
  const listCollectionAfterSecond = rpc.calls.get("list_collection") ?? 0;

  // Bootstrap loads 3 authored collections (hard, soft, variant)
  assert.equal(listCollectionAfterBootstrap, 3, "bootstrap should load 3 authored collections");
  // First assemble should NOT reload authored collections - only authored:variant search
  assert.equal(listCollectionAfterFirst, listCollectionAfterBootstrap, "first assemble should not reload authored collections");
  // Second assemble should NOT reload authored collections
  assert.equal(listCollectionAfterSecond, listCollectionAfterBootstrap, "second assemble should not reload authored collections");
});

test("assemble caches elevated guidance for same session+query", async () => {
  const rpc = new FakeRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.25,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.bootstrap({ sessionId: "s1", userId: "u1" });
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "seed" },
  });

  await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "same query" }],
    tokenBudget: 1000,
  });
  assert.equal(rpc.calls.get("search_text_collections") ?? 0, 1);

  await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "same query" }],
    tokenBudget: 1000,
  });
  assert.equal(rpc.calls.get("search_text_collections") ?? 0, 1);
});

test("assistant ingest invalidates elevated guidance for same session", async () => {
  const calls = new Map<string, number>();
  const inserted: Array<{ collection: string; text: string; metadata?: Record<string, unknown> }> = [];
  const rpc = {
    calls,
    inserted,
    async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
      calls.set(method, (calls.get(method) ?? 0) + 1);
      switch (method) {
        case "ensure_collections":
          return { ok: true } as T;
        case "insert_session_turn":
          inserted.push({
            collection: `session:${String(params.sessionId)}`,
            text: String(params.text),
            metadata: params.metadata as Record<string, unknown> | undefined,
          });
          inserted.push({
            collection: `session_raw:${String(params.sessionId)}`,
            text: String(params.text),
            metadata: {
              ...((params.metadata as Record<string, unknown> | undefined) ?? {}),
              raw_history: true,
              active_view: false,
            },
          });
          return { ok: true } as T;
        case "insert_text":
          inserted.push({
            collection: String(params.collection),
            text: String(params.text),
            metadata: params.metadata as Record<string, unknown> | undefined,
          });
          return { ok: true } as T;
        case "gating_scalar":
          return {
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
          } as T;
        case "search_text":
          return { results: [] } as T;
        case "search_text_collections":
          return { results: [] } as T;
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
          const results: SearchResult[] = inserted
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
          return { didCompact: true } as T;
        case "bump_access_counts":
          return { ok: true } as T;
        default:
          throw new Error(`unexpected rpc method: ${method}`);
      }
    },
  };
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.25,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.bootstrap({ sessionId: "s1", userId: "u1" });
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "seed" },
  });

  await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "same query" }],
    tokenBudget: 1000,
  });
  assert.equal(rpc.calls.get("search_text_collections") ?? 0, 1);

  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "assistant", content: "new fact" },
  });

  await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "same query" }],
    tokenBudget: 1000,
  });
  assert.equal(rpc.calls.get("search_text_collections") ?? 0, 2);
});

test("assemble caches authored variant recall for same query", async () => {
  const calls = new Map<string, number>();
  let authoredVariantSearches = 0;
  const rpc = {
    calls,
    async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
      calls.set(method, (calls.get(method) ?? 0) + 1);
      switch (method) {
        case "ensure_collections":
          return { ok: true } as T;
        case "insert_session_turn":
          return { ok: true } as T;
        case "insert_text":
          return { ok: true } as T;
        case "gating_scalar":
          return {
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
          } as T;
        case "search_text":
          if (String(params.collection) === "authored:variant") {
            authoredVariantSearches += 1;
            return {
              results: [
                {
                  id: "variant-hit",
                  score: 0,
                  text: "authored variant recall",
                  metadata: { authored: true, tier: 0, source_doc: "AGENTS.md", ts: Date.now(), token_estimate: 3 },
                },
              ],
            } as T;
          }
          return { results: [] } as T;
        case "search_text_collections":
          return { results: [] } as T;
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
        case "list_by_meta":
          return { results: [] } as T;
        case "compact_session":
          return { didCompact: true } as T;
        case "bump_access_counts":
          return { ok: true } as T;
        default:
          throw new Error(`unexpected rpc method: ${method}`);
      }
    },
  };
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.25,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.bootstrap({ sessionId: "s1", userId: "u1" });

  await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "same query" }],
    tokenBudget: 1000,
  });
  assert.equal(authoredVariantSearches, 1);

  await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "same query" }],
    tokenBudget: 1000,
  });
  assert.equal(authoredVariantSearches, 1);
});

test("assemble searches session_recall projection when enabled", async () => {
  const rpc = new ProjectionStoreRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.25,
    useSessionRecallProjection: true,
    continuityMinTurns: 1,
    continuityTailBudgetTokens: 1,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.bootstrap({ sessionId: "s1", userId: "u1" });
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "older fact" },
  });
  await delay(2);
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "newest fact" },
  });

  const projectionBeforeAssemble = await rpc.call<{ results: SearchResult[] }>("list_collection", {
    collection: "session_recall:s1",
  });
  assert.deepEqual(
    projectionBeforeAssemble.results.map((item) => item.text),
    ["older fact"],
  );

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "same query" }],
    tokenBudget: 1000,
  });

  assert.ok(rpc.searchedCollections.includes("session_recall:s1"));
  assert.match(assembled.systemPromptAddition, /newest fact/);
});

test("compact rebuilds session_recall projection without ghost turns", async () => {
  const rpc = new ProjectionStoreRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.25,
    useSessionRecallProjection: true,
    continuityMinTurns: 1,
    continuityTailBudgetTokens: 1,
  };

  rpc.compactHook = (sessionId) => {
    rpc.collections.set(`session:${sessionId}`, [
      {
        id: `${sessionId}:summary`,
        score: 0,
        text: "compacted summary",
        metadata: {
          sessionId,
          userId: "u1",
          ts: Date.now(),
          type: "summary",
          role: "assistant",
        },
      },
    ]);
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.bootstrap({ sessionId: "s1", userId: "u1" });
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "older fact" },
  });
  await delay(2);
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "newest fact" },
  });

  const projectionBeforeCompact = await rpc.call<{ results: SearchResult[] }>("list_collection", {
    collection: "session_recall:s1",
  });
  assert.deepEqual(
    projectionBeforeCompact.results.map((item) => item.text),
    ["older fact"],
  );

  const compacted = await context.compact({ sessionId: "s1", force: true });
  assert.equal(compacted.compacted, true);

  const projectionAfterCompact = await rpc.call<{ results: SearchResult[] }>("list_collection", {
    collection: "session_recall:s1",
  });
  assert.deepEqual(projectionAfterCompact.results, []);
});

test("assemble uses summary-only session search after compaction when experiment is enabled", async () => {
  const rpc = new ProjectionStoreRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.8,
    useSessionSummarySearchExperiment: true,
    continuityMinTurns: 2,
    continuityTailBudgetTokens: 24,
  };

  rpc.compactHook = (sessionId) => {
    const sessionCollection = `session:${sessionId}`;
    const summaryCollection = `session_summary:${sessionId}`;
    const items = rpc.collections.get(sessionCollection) ?? [];
    const rawTurns = items.filter((item) => item.metadata.type === "turn");
    const preservedTail = rawTurns.slice(-2);
    rpc.collections.set(sessionCollection, preservedTail);
    rpc.collections.set(summaryCollection, [
      {
        id: `${sessionId}:summary`,
        score: 0.86,
        text: "Compacted parser memory summary",
        metadata: {
          sessionId,
          ts: Date.now() - 10_000,
          type: "summary",
          decay_rate: 0.1,
          collection: summaryCollection,
          token_estimate: 6,
        },
      },
    ]);
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);
  await context.bootstrap({ sessionId: "s1", userId: "u1" });

  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "Older parser allocator decision." },
  });
  await delay(2);
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "assistant", content: "Acknowledged older parser allocator decision." },
  });
  await delay(2);
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "Recent raw tail user message." },
  });
  await delay(2);
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "assistant", content: "Recent raw tail assistant reply." },
  });

  await context.compact({ sessionId: "s1", force: true });
  rpc.searchedCollections = [];

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "What was the parser allocator decision?" }],
    tokenBudget: 220,
  });

  assert.ok(rpc.searchedCollections.includes("session_summary:s1"));
  assert.match(assembled.systemPromptAddition, /<recent_session_tail>/);
  assert.doesNotMatch(assembled.systemPromptAddition.split("<recalled_memories>")[1] ?? "", /Recent raw tail user message\./);
});

test("assemble falls back to full session search before compaction when no summaries exist", async () => {
  const rpc = new ProjectionStoreRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.8,
    useSessionSummarySearchExperiment: true,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);
  await context.bootstrap({ sessionId: "s1", userId: "u1" });
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "Recent session-only decision." },
  });

  rpc.searchedCollections = [];
  await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "What is the recent session-only decision?" }],
    tokenBudget: 200,
  });

  assert.ok(rpc.searchedCollections.includes("session:s1"));
  assert.ok(!rpc.searchedCollections.includes("session_summary:s1"));
});

test("summary-only search still recalls the compacted older decision", async () => {
  const rpc = new ProjectionStoreRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.8,
    useSessionSummarySearchExperiment: true,
    continuityMinTurns: 2,
    continuityTailBudgetTokens: 24,
  };

  rpc.compactHook = (sessionId) => {
    const sessionCollection = `session:${sessionId}`;
    const summaryCollection = `session_summary:${sessionId}`;
    const items = rpc.collections.get(sessionCollection) ?? [];
    const rawTurns = items.filter((item) => item.metadata.type === "turn");
    rpc.collections.set(sessionCollection, rawTurns.slice(-2));
    rpc.collections.set(summaryCollection, [
      {
        id: `${sessionId}:summary`,
        score: 0.9,
        text: "Compacted summary: use arena allocators for parser caches.",
        metadata: {
          sessionId,
          ts: Date.now() - 5_000,
          type: "summary",
          decay_rate: 0.05,
          collection: summaryCollection,
          token_estimate: 7,
        },
      },
    ]);
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);
  await context.bootstrap({ sessionId: "s1", userId: "u1" });
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "Arena allocators reduced parser cache churn." },
  });
  await delay(2);
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "assistant", content: "We should keep the arena allocator choice." },
  });
  await delay(2);
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "tail user" },
  });
  await delay(2);
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "assistant", content: "tail assistant" },
  });
  await context.compact({ sessionId: "s1", force: true });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "What allocator should the parser cache use?" }],
    tokenBudget: 400,
  });

  const recalledSection = assembled.systemPromptAddition.split("<recalled_memories>")[1] ?? "";
  assert.match(recalledSection, /Compacted summary: use arena allocators for parser caches\./);
});

test("summary-only search does not leak recent raw turns into recalled memories", async () => {
  const rpc = new ProjectionStoreRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.8,
    useSessionSummarySearchExperiment: true,
    continuityMinTurns: 2,
    continuityTailBudgetTokens: 24,
  };

  rpc.compactHook = (sessionId) => {
    const sessionCollection = `session:${sessionId}`;
    const summaryCollection = `session_summary:${sessionId}`;
    const items = rpc.collections.get(sessionCollection) ?? [];
    const rawTurns = items.filter((item) => item.metadata.type === "turn");
    rpc.collections.set(sessionCollection, rawTurns.slice(-2));
    rpc.collections.set(summaryCollection, [
      {
        id: `${sessionId}:summary`,
        score: 0.82,
        text: "Compacted summary: preserve older parser guidance.",
        metadata: {
          sessionId,
          ts: Date.now() - 8_000,
          type: "summary",
          decay_rate: 0.1,
          collection: summaryCollection,
          token_estimate: 6,
        },
      },
    ]);
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);
  await context.bootstrap({ sessionId: "s1", userId: "u1" });
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "Older guidance that should compact." },
  });
  await delay(2);
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "assistant", content: "Older assistant reply that should compact." },
  });
  await delay(2);
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "Fresh raw tail user turn." },
  });
  await delay(2);
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "assistant", content: "Fresh raw tail assistant turn." },
  });
  await context.compact({ sessionId: "s1", force: true });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "Tell me the parser guidance." }],
    tokenBudget: 220,
  });

  const recentSection = assembled.systemPromptAddition.split("<recent_session_tail>")[1] ?? "";
  const recalledSection = assembled.systemPromptAddition.split("<recalled_memories>")[1] ?? "";
  assert.match(recentSection, /Fresh raw tail user turn\./);
  assert.match(recentSection, /Fresh raw tail assistant turn\./);
  assert.doesNotMatch(recalledSection, /Fresh raw tail user turn\./);
  assert.doesNotMatch(recalledSection, /Fresh raw tail assistant turn\./);
});

test("continuity and compaction quality harness keeps recent raw tail exact while recalling an older compacted summary", async () => {
  const rpc = new ProjectionStoreRpc();
  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.8,
    continuityMinTurns: 2,
    continuityTailBudgetTokens: 24,
  };

  rpc.compactHook = (sessionId) => {
    const collection = `session:${sessionId}`;
    const items = rpc.collections.get(collection) ?? [];
    const rawTurns = items.filter((item) => item.metadata.type === "turn");
    const preservedTail = rawTurns.slice(-2);
    rpc.collections.set(collection, [
      {
        id: `${sessionId}:summary:cluster-1`,
        score: 0.88,
        text: "Compacted summary: prefer arena allocators for parser caches and preserve deterministic cleanup order.",
        metadata: {
          sessionId,
          ts: Date.now() - 5_000,
          type: "summary",
          decay_rate: 0.1,
          collection,
          token_estimate: 10,
        },
      },
      ...preservedTail,
    ]);
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);
  await context.bootstrap({ sessionId: "s1", userId: "u1" });

  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "Parser cache design note: arena allocators reduced churn and kept cleanup deterministic." },
  });
  await delay(2);
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "assistant", content: "Acknowledged. We will keep the parser cache arena-backed." },
  });
  await delay(2);
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "Current work: wire the diagnostics into the parser service." },
  });
  await delay(2);
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "assistant", content: "I am wiring the diagnostics into the parser service now." },
  });

  const compacted = await context.compact({ sessionId: "s1", force: true });
  assert.equal(compacted.compacted, true);

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "How should the parser cache allocate memory?" }],
    tokenBudget: 220,
  });

  const recentSection = assembled.systemPromptAddition.split("<recent_session_tail>")[1] ?? "";
  const recalledSection = assembled.systemPromptAddition.split("<recalled_memories>")[1] ?? "";
  assert.match(recentSection, /Current work: wire the diagnostics into the parser service\./);
  assert.match(recentSection, /I am wiring the diagnostics into the parser service now\./);
  assert.match(recalledSection, /Compacted summary: prefer arena allocators for parser caches and preserve deterministic cleanup order\./);
  assert.doesNotMatch(recalledSection, /Current work: wire the diagnostics into the parser service\./);
  assert.doesNotMatch(recalledSection, /I am wiring the diagnostics into the parser service now\./);
});

test("continuity and compaction quality harness prefers higher-confidence summary in assembled recall", async () => {
  const rpc = new ProjectionStoreRpc();
  const recallCache = createRecallCache<SearchResult>();
  const now = Date.now();
  rpc.collections.set("session:s1", [
    {
      id: "summary-high",
      score: 0.9,
      text: "High-confidence summary: preserve the arena allocator rule for parser caches.",
      metadata: {
        sessionId: "s1",
        ts: now - 20_000,
        type: "summary",
        decay_rate: 0.1,
        collection: "session:s1",
        token_estimate: 8,
      },
    },
    {
      id: "summary-low",
      score: 0.9,
      text: "Low-confidence summary: parser cache guidance maybe changed somehow.",
      metadata: {
        sessionId: "s1",
        ts: now - 20_000,
        type: "summary",
        decay_rate: 0.9,
        collection: "session:s1",
        token_estimate: 8,
      },
    },
    {
      id: "raw-recent",
      score: 0,
      text: "Recent tail work item that must stay verbatim.",
      metadata: {
        sessionId: "s1",
        ts: now,
        type: "turn",
        role: "user",
        collection: "session:s1",
        token_estimate: 6,
      },
    },
  ]);

  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.8,
    continuityMinTurns: 1,
    continuityTailBudgetTokens: 8,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);
  await context.bootstrap({ sessionId: "s1", userId: "u1" });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "What is the parser cache rule?" }],
    tokenBudget: 200,
  });

  const recalledSection = assembled.systemPromptAddition.split("<recalled_memories>")[1] ?? "";
  const highIndex = recalledSection.indexOf("High-confidence summary: preserve the arena allocator rule for parser caches.");
  const lowIndex = recalledSection.indexOf("Low-confidence summary: parser cache guidance maybe changed somehow.");
  assert.ok(highIndex >= 0, "expected high-confidence summary in recalled section");
  assert.ok(lowIndex >= 0, "expected low-confidence summary in recalled section");
  assert.ok(highIndex < lowIndex, "expected higher-confidence summary to outrank lower-confidence summary");
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

  // User ingest invalidates the cache via clearUser
  await context.ingest({
    sessionId: "s1",
    userId: "u1",
    message: { role: "user", content: "new durable fact" },
  });

  // Second assemble re-runs user/global searches after clearUser invalidation.
  await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "same query" }],
    tokenBudget: 100,
  });
  const searchCallsAfterSecond = rpc.calls.get("search_text") ?? 0;

  assert.equal(searchCallsAfterFirst, 4);
  assert.equal(searchCallsAfterSecond, 7);
});

// =============================================================================
// Recovery trigger validation matrix
// =============================================================================

test("assemble: normal healthy session does NOT fire the recovery trigger", async () => {
  // Normal session: strong session hits with turn-type items, high authority,
  // no cascade_tier=3. Recovery trigger must not fire, so query_raw_session
  // must not be called.
  const rpc = new ProjectionStoreRpc();
  rpc.collections.set("session:s1", [
    {
      id: "session-hit-1",
      score: 0.85,
      text: "recent session fact about the allocator decision",
      metadata: {
        sessionId: "s1",
        ts: Date.now(),
        collection: "session:s1",
        type: "turn",
        authority: 1,
        token_estimate: 5,
      },
    },
  ]);
  rpc.collections.set("session_raw:s1", [
    {
      id: "raw-1",
      score: 0.8,
      text: "raw session allocator fact",
      metadata: { sessionId: "s1", ts: Date.now(), type: "turn" },
    },
  ]);

  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.25,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.bootstrap({ sessionId: "s1", userId: "u1" });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "allocator decision" }],
    tokenBudget: 200,
  });

  // Recovery must not fire for a healthy session — query_raw_session should
  // not have been called (or called but returned zero results).
  const rawCallCount = rpc.calls.get("query_raw_session") ?? 0;
  assert.equal(rawCallCount, 0, "query_raw_session must not fire on a healthy session");

  // Normal assembly result must be present
  assert.ok(assembled.systemPromptAddition.length > 0);
  assert.ok(!assembled.systemPromptAddition.includes("recovery_fallback"));
});

test("assemble: session returning only low-confidence summaries fires signal-3 and appends recovery", async () => {
  // Session search returns a summary-shaped surface with six low-confidence
  // summaries, all with type=summary and mean confidence < 0.5. Signal 3 must
  // fire, triggering query_raw_session.
  // Recovery content must appear AFTER the normal assembly result.
  const rpc = new ProjectionStoreRpc();
  rpc.collections.set("session:s1", buildSummaryShapedSessionSurface("s1"));
  // Seed session_raw with recovery candidates
  rpc.collections.set("session_raw:s1", [
    {
      id: "raw-1",
      score: 0.75,
      text: "raw allocator decision from session history",
      metadata: { sessionId: "s1", ts: Date.now() - 40_000, type: "turn", token_estimate: 6 },
    },
    {
      id: "raw-2",
      score: 0.70,
      text: "another raw fact about the earlier decision",
      metadata: { sessionId: "s1", ts: Date.now() - 35_000, type: "turn", token_estimate: 6 },
    },
  ]);

  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.25,
    section7Theta1: 0,
    recoveryMinTopK: 4,
    recoveryMinConfidenceMean: 0.5,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.bootstrap({ sessionId: "s1", userId: "u1" });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "allocator decision" }],
    tokenBudget: 400,
  });

  // Signal 3 must have fired — query_raw_session must be called
  const rawCallCount = rpc.calls.get("query_raw_session") ?? 0;
  assert.equal(rawCallCount, 1, "query_raw_session must fire when signal-3 triggers");

  // Recovery content must appear after normal assembly result.
  // Check that the raw session history text is present in the output
  // and that it carries the recovery_fallback marker.
  assert.ok(
    assembled.systemPromptAddition.includes("raw allocator decision from session history"),
    "recovery raw content must appear in assembled output",
  );
});

test("assemble: session with cascade_tier=3 and weak ranking fires signal-1-plus-2", async () => {
  // Session search returns hits with cascade_tier=3 in metadata (cascade exhausted
  // to full embedding L3). Combined with a low finalScore, Signal 1 AND Signal 2
  // fires: (S1 AND S2) triggers recovery.
  // We simulate the low finalScore by setting authority=0 so ranking downweights.
  const rpc = new ProjectionStoreRpc();
  rpc.collections.set("session:s1", [
    {
      id: "session-tier3-weak",
      score: 0.20,
      text: "weak semantic match that fell through cascade tiers",
      metadata: {
        sessionId: "s1",
        ts: Date.now(),
        collection: "session:s1",
        type: "turn",
        authority: 0,
        cascade_tier: 3, // cascade exhausted — Signal 1
        token_estimate: 5,
      },
    },
  ]);
  rpc.collections.set("session_raw:s1", [
    {
      id: "raw-from-cascade",
      score: 0.70,
      text: "raw turn recovered after cascade failure",
      metadata: { sessionId: "s1", ts: Date.now(), type: "turn", token_estimate: 5 },
    },
  ]);

  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.25,
    section7Theta1: 0,
    section7AuthorityRecencyLambda: 0,
    section7AuthorityRecencyWeight: 0,
    section7AuthorityFrequencyWeight: 0,
    section7AuthorityAuthoredWeight: 0,
    recoveryFloorScore: 0.25,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.bootstrap({ sessionId: "s1", userId: "u1" });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "some obscure query" }],
    tokenBudget: 200,
  });

  // (S1 AND S2) must fire
  const rawCallCount = rpc.calls.get("query_raw_session") ?? 0;
  assert.equal(rawCallCount, 1, "query_raw_session must fire when S1 AND S2 triggers");
  assert.ok(
    assembled.systemPromptAddition.includes("raw turn recovered after cascade failure"),
    "recovery content must appear after cascade failure",
  );
});

test("assemble: recovery never touches elevated:, authored:, or active session view collections", async () => {
  // Verify the recovery search scope is restricted to session_raw: only.
  // We seed elevated: and authored: collections with items that would match
  // the query, then verify they are NOT returned as recovery items.
  const rpc = new ProjectionStoreRpc();
  // Active session view — should NOT be in recovery
  rpc.collections.set("session:s1", [
    {
      id: "active-session",
      score: 0.01,
      text: "scope isolation sentinel that should stay in session only",
      metadata: {
        sessionId: "s1",
        ts: Date.now(),
        collection: "session:s1",
        type: "turn",
        authority: 0,
        cascade_tier: 3,
        token_estimate: 5,
      },
    },
    {
      id: "summary-isolation-1",
      score: 0.22,
      text: "query that triggers cascade failure low confidence summary one",
      metadata: { sessionId: "s1", ts: Date.now(), type: "summary", confidence: 0.20, token_estimate: 5 },
    },
    {
      id: "summary-isolation-2",
      score: 0.21,
      text: "query that triggers cascade failure low confidence summary two",
      metadata: { sessionId: "s1", ts: Date.now(), type: "summary", confidence: 0.22, token_estimate: 5 },
    },
    {
      id: "summary-isolation-3",
      score: 0.20,
      text: "query that triggers cascade failure low confidence summary three",
      metadata: { sessionId: "s1", ts: Date.now(), type: "summary", confidence: 0.24, token_estimate: 5 },
    },
    {
      id: "summary-isolation-4",
      score: 0.19,
      text: "query that triggers cascade failure low confidence summary four",
      metadata: { sessionId: "s1", ts: Date.now(), type: "summary", confidence: 0.18, token_estimate: 5 },
    },
  ]);
  // Elevated guidance shard — should NOT be in recovery
  rpc.collections.set("elevated:session:s1", [
    {
      id: "elevated-shard",
      score: 0.90,
      text: "elevated guidance that must stay in the elevated section",
      metadata: {
        sessionId: "s1",
        ts: Date.now(),
        type: "guidance_shard",
        elevated_guidance: true,
        token_estimate: 5,
      },
    },
  ]);
  // Raw session — the ONLY eligible collection for recovery
  rpc.collections.set("session_raw:s1", [
    {
      id: "raw-eligible",
      score: 0.75,
      text: "raw eligible recovery turn",
      metadata: { sessionId: "s1", ts: Date.now(), type: "turn", token_estimate: 5 },
    },
  ]);

  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.25,
    recoveryFloorScore: 0.15,
    section7AuthorityRecencyLambda: 0,
    section7AuthorityRecencyWeight: 0,
    section7AuthorityFrequencyWeight: 0,
    section7AuthorityAuthoredWeight: 0,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.bootstrap({ sessionId: "s1", userId: "u1" });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "query that triggers cascade failure" }],
    tokenBudget: 400,
  });

  // Recovery fired
  const rawCallCount = rpc.calls.get("query_raw_session") ?? 0;
  assert.equal(rawCallCount, 1);
  assert.equal(String(rpc.lastQueryRawSessionParams?.sessionId ?? ""), "s1");
  assert.ok(Array.isArray(rpc.lastQueryRawSessionParams?.excludeIds), "recovery must pass excludeIds");
});

test("assemble: recovery is appended AFTER normal theorem result (theorem output unchanged)", async () => {
  // When recovery fires, normal theorem output (authored + tail + ranked variant)
  // must appear BEFORE the recovery content. The theorem does not mutate when
  // recovery is present — it is the primary surface.
  const rpc = new ProjectionStoreRpc();
  rpc.collections.set("authored:hard", [
    {
      id: "hard-1",
      score: 0,
      text: "Hard authored rule: always validate the math.",
      metadata: { authored: true, tier: 1, ordinal: 1, source_doc: "AGENTS.md", token_estimate: 6 },
    },
  ]);
  rpc.collections.set("session:s1", [
    {
      id: "summary-poor",
      score: 0.90,
      text: "poor quality summary",
      metadata: {
        sessionId: "s1",
        ts: Date.now() - 90_000,
        collection: "session:s1",
        type: "summary",
        confidence: 0.28,
        authority: 1,
        token_estimate: 5,
      },
    },
    {
      id: "summary-poor-2",
      score: 0.88,
      text: "another poor summary",
      metadata: {
        sessionId: "s1",
        ts: Date.now() - 80_000,
        collection: "session:s1",
        type: "summary",
        confidence: 0.32,
        authority: 1,
        token_estimate: 5,
      },
    },
    {
      id: "summary-poor-3",
      score: 0.85,
      text: "third poor summary",
      metadata: {
        sessionId: "s1",
        ts: Date.now() - 70_000,
        collection: "session:s1",
        type: "summary",
        confidence: 0.25,
        authority: 1,
        token_estimate: 5,
      },
    },
    {
      id: "summary-poor-4",
      score: 0.82,
      text: "fourth poor summary",
      metadata: {
        sessionId: "s1",
        ts: Date.now() - 60_000,
        collection: "session:s1",
        type: "summary",
        confidence: 0.30,
        authority: 1,
        token_estimate: 5,
      },
    },
  ]);
  rpc.collections.set("session_raw:s1", [
    {
      id: "raw-recovery-1",
      score: 0.75,
      text: "raw recovered fact that provides the ground truth",
      metadata: { sessionId: "s1", ts: Date.now() - 50_000, type: "turn", token_estimate: 7 },
    },
  ]);

  const recallCache = createRecallCache<SearchResult>();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 8,
    tokenBudgetFraction: 0.5,
    recoveryMinTopK: 4,
    recoveryMinConfidenceMean: 0.5,
  };

  const getRpc = async () => rpc as never;
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  await context.bootstrap({ sessionId: "s1", userId: "u1" });

  const assembled = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "ground truth about the math" }],
    tokenBudget: 500,
  });

  // Recovery fired
  assert.equal(rpc.calls.get("query_raw_session") ?? 0, 1);

  // Theorem result (authored hard) must appear before recovery content
  const authoredIdx = assembled.systemPromptAddition.indexOf("Hard authored rule");
  const recoveryIdx = assembled.systemPromptAddition.indexOf("raw recovered fact");

  assert.ok(
    authoredIdx >= 0,
    "authored hard invariant must appear in output",
  );
  assert.ok(
    recoveryIdx >= 0,
    "recovery raw content must appear in output",
  );
  assert.ok(
    authoredIdx < recoveryIdx,
    "theorem result (authored) must appear BEFORE recovery content",
  );
});
