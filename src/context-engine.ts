import {
  DEFAULT_CONTINUITY_MIN_TURNS,
  DEFAULT_CONTINUITY_TAIL_BUDGET_TOKENS,
  selectRecentTail,
} from "./continuity.js";
import { scoreCandidates } from "./scoring.js";
import { buildMemoryHeader, recentIds } from "./recall-utils.js";
import { countTokens, estimateTokens, fitPromptBudget } from "./tokens.js";
import type { RpcGetter } from "./plugin-runtime.js";
import type {
  ContextAssembleArgs,
  ContextBootstrapArgs,
  ContextCompactArgs,
  ContextIngestArgs,
  GatingResult,
  PluginConfig,
  RecallCache,
  SearchResult,
} from "./types.js";

const AUTHORED_HARD_COLLECTION = "authored:hard";
const AUTHORED_SOFT_COLLECTION = "authored:soft";
const AUTHORED_VARIANT_COLLECTION = "authored:variant";

export function buildContextEngineFactory(
  getRpc: RpcGetter,
  cfg: PluginConfig,
  recallCache: RecallCache<SearchResult>,
) {
  let authoredHardCache: SearchResult[] | null = null;
  let authoredSoftCache: SearchResult[] | null = null;

  return {
    ownsCompaction: true,
    async bootstrap({ sessionId, userId }: ContextBootstrapArgs) {
      const rpc = await getRpc();
      await rpc.call("ensure_collections", {
        collections: [
          `session:${sessionId}`,
          `turns:${userId}`,
          `user:${userId}`,
          "global",
          AUTHORED_HARD_COLLECTION,
          AUTHORED_SOFT_COLLECTION,
          AUTHORED_VARIANT_COLLECTION,
        ],
      });
      return { ok: true };
    },
    async ingest({ sessionId, userId, message, isHeartbeat }: ContextIngestArgs) {
      if (isHeartbeat) {
        return { ingested: false };
      }

      const rpc = await getRpc();
      const ts = Date.now();
      void rpc.call("insert_text", {
        collection: `session:${sessionId}`,
        id: `${sessionId}:${ts}`,
        text: message.content,
        metadata: { role: message.role, ts, userId, sessionId, type: "turn" },
      }).catch(console.error);

      if (message.role === "user") {
        try {
          recallCache.clearUser(userId);
          await rpc.call("insert_text", {
            collection: `turns:${userId}`,
            id: `${userId}:${ts}`,
            text: message.content,
            metadata: { role: message.role, ts, userId, sessionId, type: "turn" },
          });

          const gating = await rpc.call<GatingResult>("gating_scalar", {
            userId,
            text: message.content,
          });

          if (gating.g >= (cfg.ingestionGateThreshold ?? 0.35)) {
            void rpc.call("insert_text", {
              collection: `user:${userId}`,
              id: `${userId}:${ts}`,
              text: message.content,
              metadata: {
                ts,
                sessionId,
                type: "turn",
                userId,
                gating_score: gating.g,
                gating_t: gating.t,
                gating_h: gating.h,
                gating_r: gating.r,
                gating_d: gating.d,
                gating_p: gating.p,
                gating_a: gating.a,
                gating_dtech: gating.dtech,
                gating_gconv: gating.gconv,
                gating_gtech: gating.gtech,
              },
            }).catch(console.error);
          }
        } catch {
          // Session storage already happened; skip durable promotion on gating failure.
        }
      }

      return { ingested: true };
    },
    async assemble({ sessionId, userId, messages, tokenBudget }: ContextAssembleArgs) {
      const queryText = messages.at(-1)?.content ?? "";
      if (!queryText) {
        return {
          messages,
          estimatedTokens: countTokens(messages),
          systemPromptAddition: "",
        };
      }

      const excluded = recentIds(messages, 4);
      const cached = recallCache.get({ userId, queryText });

      try {
        const rpc = await getRpc();
        const [authoredHard, authoredSoft] = await loadAuthoredCollections(rpc, {
          hard: authoredHardCache,
          soft: authoredSoftCache,
        });
        authoredHardCache = authoredHard;
        authoredSoftCache = authoredSoft;

        const memoryBudget = tokenBudget * (cfg.tokenBudgetFraction ?? 0.25);
        const hardItems = authoredHard;
        const hardUsed = tokenCostSum(hardItems);
        const sessionRecords = await rpc.call<{ results: SearchResult[] }>("list_by_meta", {
          collection: `session:${sessionId}`,
          key: "sessionId",
          value: sessionId,
        });
        const rawSessionTurns = sortChronological(
          sessionRecords.results.filter((item) => item.metadata.type !== "summary"),
        );
        const minTurns = cfg.continuityMinTurns ?? DEFAULT_CONTINUITY_MIN_TURNS;
        const tailTarget = cfg.continuityTailBudgetTokens ?? DEFAULT_CONTINUITY_TAIL_BUDGET_TOKENS;
        const baseTail = selectRecentTail(rawSessionTurns, {
          minTurns,
          tailBudgetTokens: 0,
          tokenCost,
        });
        const baseTailUsed = baseTail.baseTokens;
        const authoredSoftTarget = Math.max(0, memoryBudget * (cfg.authoredSoftBudgetFraction ?? 0.3));
        const softBudget = Math.max(0, Math.min(authoredSoftTarget, memoryBudget - hardUsed - baseTailUsed));
        const softItems = fitPromptBudget(authoredSoft, softBudget);
        const remainingAfterHardSoft = Math.max(0, memoryBudget - hardUsed - tokenCostSum(softItems));
        const effectiveTailBudget = Math.min(
          Math.max(tailTarget, baseTailUsed),
          remainingAfterHardSoft,
        );
        const recentTailSelection = selectRecentTail(rawSessionTurns, {
          minTurns,
          tailBudgetTokens: effectiveTailBudget,
          tokenCost,
        });
        const recentTail = markRecentTail(
          recentTailSelection.recent,
          recentTailSelection.base.length,
        );
        const tailBaseItems = recentTail.slice(-recentTailSelection.base.length);
        const tailExtensionItems = recentTail.slice(0, Math.max(0, recentTail.length - recentTailSelection.base.length));
        const retrievalBudget = Math.max(0, memoryBudget - hardUsed - tokenCostSum(softItems) - tokenCostSum(recentTail));
        const recentTailIDs = recentTail.map((item) => item.id);

        const [sessionHits, userHits, globalHits, authoredVariantHits] = await Promise.all([
          rpc.call<{ results: SearchResult[] }>("search_text", {
            collection: `session:${sessionId}`,
            text: queryText,
            k: cfg.topK ?? 8,
            excludeIds: [...excluded, ...recentTailIDs],
          }),
          cached
            ? Promise.resolve({ results: cached.userHits })
            : rpc.call<{ results: SearchResult[] }>("search_text", {
                collection: `user:${userId}`,
                text: queryText,
                k: Math.ceil((cfg.topK ?? 8) / 2),
              }),
          cached
            ? Promise.resolve({ results: cached.globalHits })
            : rpc.call<{ results: SearchResult[] }>("search_text", {
                collection: "global",
                text: queryText,
                k: Math.ceil((cfg.topK ?? 8) / 4),
              }),
          cached?.authoredVariantHits
            ? Promise.resolve({ results: cached.authoredVariantHits })
            : rpc.call<{ results: SearchResult[] }>("search_text", {
                collection: AUTHORED_VARIANT_COLLECTION,
                text: queryText,
                k: Math.ceil((cfg.topK ?? 8) / 2),
              }),
        ]);

        if (!cached) {
          recallCache.put({
            userId,
            queryText,
            userHits: userHits.results,
            globalHits: globalHits.results,
            authoredVariantHits: authoredVariantHits.results,
          });
        }

        const ranked = scoreCandidates(
          [
            ...authoredVariantHits.results,
            ...sessionHits.results,
            ...userHits.results,
            ...globalHits.results,
          ],
          {
            alpha: cfg.alpha,
            beta: cfg.beta,
            gamma: cfg.gamma,
            delta: cfg.compactionQualityWeight ?? 0.5,
            recencyLambdaSession: cfg.recencyLambdaSession,
            recencyLambdaUser: cfg.recencyLambdaUser,
            recencyLambdaGlobal: cfg.recencyLambdaGlobal,
            sessionId,
            userId,
          },
        );

        const selected = [
          ...hardItems,
          ...tailBaseItems,
          ...softItems,
          ...tailExtensionItems,
          ...fitPromptBudget(ranked, retrievalBudget),
        ];

        const selectedMessages = selected.map((item) => ({
          role: "system",
          content: item.text,
        }));

        return {
          messages: [...selectedMessages, ...messages],
          estimatedTokens: countTokens(selectedMessages) + countTokens(messages),
          systemPromptAddition: buildMemoryHeader(selected),
        };
      } catch {
        return {
          messages,
          estimatedTokens: countTokens(messages),
          systemPromptAddition: "",
        };
      }
    },
    async compact({ sessionId, force, targetSize }: ContextCompactArgs) {
      const rpc = await getRpc();
      const result = await rpc.call<{ compacted?: boolean; didCompact?: boolean }>("compact_session", {
        sessionId,
        force,
        targetSize: targetSize ?? cfg.compactThreshold,
        continuityMinTurns: cfg.continuityMinTurns ?? DEFAULT_CONTINUITY_MIN_TURNS,
        continuityTailBudgetTokens: cfg.continuityTailBudgetTokens ?? DEFAULT_CONTINUITY_TAIL_BUDGET_TOKENS,
      }).catch(() => ({ compacted: false }));
      const compacted = "didCompact" in result
        ? (result.didCompact ?? result.compacted ?? false)
        : (result.compacted ?? false);

      return {
        ok: true,
        compacted,
      };
    },
  };
}

async function loadAuthoredCollections(
  rpc: Awaited<ReturnType<RpcGetter>>,
  cached: { hard: SearchResult[] | null; soft: SearchResult[] | null },
): Promise<[SearchResult[], SearchResult[]]> {
  if (cached.hard && cached.soft) {
    return [cached.hard, cached.soft];
  }

  const [hard, soft] = await Promise.all([
    cached.hard
      ? Promise.resolve({ results: cached.hard })
      : rpc.call<{ results: SearchResult[] }>("list_collection", { collection: AUTHORED_HARD_COLLECTION }),
    cached.soft
      ? Promise.resolve({ results: cached.soft })
      : rpc.call<{ results: SearchResult[] }>("list_collection", { collection: AUTHORED_SOFT_COLLECTION }),
  ]);

  return [hard.results, soft.results];
}

function tokenCostSum(items: SearchResult[]): number {
  return items.reduce((sum, item) => sum + tokenCost(item), 0);
}

function tokenCost(item: SearchResult): number {
  const estimate = item.metadata.token_estimate;
  if (typeof estimate === "number" && estimate > 0) {
    return estimate;
  }
  return estimateTokens(item.text);
}

function sortChronological(items: SearchResult[]): SearchResult[] {
  return [...items].sort((left, right) => {
    const leftTS = metadataTimestamp(left);
    const rightTS = metadataTimestamp(right);
    if (leftTS === rightTS) {
      return left.id.localeCompare(right.id);
    }
    return leftTS - rightTS;
  });
}

function metadataTimestamp(item: SearchResult): number {
  const raw = item.metadata.ts;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function markRecentTail(items: SearchResult[], baseCount: number): SearchResult[] {
  const baseStart = Math.max(0, items.length - baseCount);
  return items.map((item, idx) => ({
    ...item,
    metadata: {
      ...item.metadata,
      continuity_tail: true,
      continuity_base: idx >= baseStart,
    },
  }));
}
