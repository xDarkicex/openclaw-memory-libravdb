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
        const excludeIds = new Set(Array.isArray(params.excludeIds) ? params.excludeIds.map(String) : []);
        const results = this.ensureCollection(collection)
          .filter((item) => !excludeIds.has(item.id))
          .map((item) => ({
            ...item,
            metadata: {
              ...item.metadata,
              collection,
            },
          }));
        return { results } as T;
      }
      case "search_text_collections":
        return {
          results: (Array.isArray(params.collections) ? params.collections : [])
            .flatMap((collection) => this.ensureCollection(String(collection)))
            .map((item) => ({
              ...item,
              metadata: {
                ...item.metadata,
                collection: typeof item.metadata.collection === "string"
                  ? item.metadata.collection
                  : String(
                    Array.isArray(params.collections) && params.collections.length > 0
                      ? params.collections[0]
                      : "",
                  ),
              },
            })),
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
  const memorySection = buildMemoryPromptSection(getRpc, cfg, recallCache);

  const prompt = await memorySection({
    availableTools: new Set(["memory_search"]),
    messages: [{ role: "user", content: "winner" }],
    userId: "u1",
  });

  const rendered = prompt.join("\n");
  const userIndex = rendered.indexOf("durable user memory winner");
  const globalIndex = rendered.indexOf("stale global summary loser");
  assert.ok(userIndex >= 0, "expected durable user memory in prompt section");
  assert.ok(globalIndex >= 0, "expected stale global summary in prompt section");
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

  const prompt = await memorySection({
    availableTools: new Set(["memory_search"]),
    citationsMode: "inline",
    messages: [{ role: "user", content: "what do you know?" }],
    userId: "u1",
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

test("real sidecar assemble profile probe", async (t) => {
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

      try {
        await context.bootstrap({ sessionId, userId });
        if (isSummaryOnly) {
          // Build a richer compacted session so summary-only probing does not
          // overfit a trivial one-summary collection.
          let turnIndex = 0;
          for (let batch = 0; batch < 3; batch += 1) {
            for (let i = 0; i < 6; i += 1) {
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
          for (let i = 0; i < (cfg.useSessionRecallProjection ? 8 : 8); i += 1) {
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
        process.stdout.write(
          `[probe:${label}] search_collection=${searchCollection} record_count=${collectionState.results.length} summary_record_count=${summaryState.results.length}\n`,
        );

        for (let i = 0; i < 3; i += 1) {
          const prompt = await memorySection({
            availableTools: new Set(["memory_search"]),
            messages: [{ role: "user", content: queryText }],
            userId,
          });
          assert.ok(prompt.length > 0);

          const assembled = await context.assemble({
            sessionId,
            userId,
            messages: [{ role: "user", content: queryText }],
            tokenBudget: 4000,
          });
          const passLogs = assembled._profile ?? [];
          if (passLogs.length === 0) {
            process.stdout.write(`[probe:${label}:pass${i + 1}] no profiler lines captured\n`);
          }
          for (const line of passLogs) {
            process.stdout.write(`[probe:${label}:pass${i + 1}] ${line}\n`);
          }
          assert.ok(assembled.messages.length > 0);
          assert.ok(assembled.systemPromptAddition.length > 0);
        }
      } finally {
        await runtime.shutdown();
      }
    }

    await runScenario("baseline", {});
    await runScenario("session_recall", { useSessionRecallProjection: true });
    await runScenario("session_summary_only", { useSessionSummarySearchExperiment: true });
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
          const prompt = await memorySection({
            availableTools: new Set(["memory_search"]),
            messages: [{ role: "user", content: queryText }],
            userId,
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
  const memorySection = buildMemoryPromptSection(getRpc, cfg, recallCache);
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  // Memory prompt section seeds the cache with user/global hits
  // memorySection does: search_text user + search_text global = 2 calls
  await memorySection({
    availableTools: new Set(["memory_search"]),
    messages: [{ role: "user", content: "cached query" }],
    userId: "u1",
  });

  // First assemble - uses cached user/global hits and one authored:variant lookup
  // assemble does: session (1) + authored:variant (1) = 2 calls (user/global are cached)
  const first = await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "cached query" }],
    tokenBudget: 100,
  });
  const searchCallsAfterFirst = rpc.calls.get("search_text") ?? 0;

  // Memory prompt section runs again (next turn), re-seeds cache: 2 calls
  await memorySection({
    availableTools: new Set(["memory_search"]),
    messages: [{ role: "user", content: "cached query" }],
    userId: "u1",
  });

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
  // After first pair: memorySection(2) + assemble(2) = 4 calls
  assert.equal(searchCallsAfterFirst, 4);
  // After second pair: 4 + 3 = 7 calls total
  assert.equal(searchCallsAfterSecond, 7);
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
  const memorySection = buildMemoryPromptSection(getRpc, cfg, recallCache);
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  // Bootstrap loads authored collections (3 list_collection calls)
  await context.bootstrap({ sessionId: "s1", userId: "u1" });
  const listCollectionAfterBootstrap = rpc.calls.get("list_collection") ?? 0;

  // Memory prompt section seeds the cache for first assemble
  await memorySection({
    availableTools: new Set(["memory_search"]),
    messages: [{ role: "user", content: "query a" }],
    userId: "u1",
  });

  // First assemble
  await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "query a" }],
    tokenBudget: 100,
  });
  const listCollectionAfterFirst = rpc.calls.get("list_collection") ?? 0;

  // Memory prompt section seeds the cache for second assemble
  await memorySection({
    availableTools: new Set(["memory_search"]),
    messages: [{ role: "user", content: "query b" }],
    userId: "u1",
  });

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
  const memorySection = buildMemoryPromptSection(getRpc, cfg, recallCache);
  const context = buildContextEngineFactory(getRpc, cfg, recallCache);

  // Memory prompt section seeds the cache: 2 calls (user + global)
  await memorySection({
    availableTools: new Set(["memory_search"]),
    messages: [{ role: "user", content: "same query" }],
    userId: "u1",
  });

  // First assemble: session (1) + authored:variant (1) = 2 calls
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

  // Memory prompt section re-seeds: 2 calls (user + global)
  await memorySection({
    availableTools: new Set(["memory_search"]),
    messages: [{ role: "user", content: "same query" }],
    userId: "u1",
  });

  // Second assemble: session (1) only; authored:variant is cached
  await context.assemble({
    sessionId: "s1",
    userId: "u1",
    messages: [{ role: "user", content: "same query" }],
    tokenBudget: 100,
  });
  const searchCallsAfterSecond = rpc.calls.get("search_text") ?? 0;

  // After first pair: memorySection(2) + assemble(2) = 4 calls
  assert.equal(searchCallsAfterFirst, 4);
  // After second pair: 4 + 3 = 7 calls total
  assert.equal(searchCallsAfterSecond, 7);
});
