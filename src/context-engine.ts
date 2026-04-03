import {
  DEFAULT_CONTINUITY_MIN_TURNS,
  DEFAULT_CONTINUITY_PRIOR_CONTEXT_TOKENS,
  DEFAULT_CONTINUITY_TAIL_BUDGET_TOKENS,
  selectRecentTail,
} from "./continuity.js";
import {
  expandSection7HopCandidates,
  mergeSection7VariantCandidates,
  rankSection7VariantCandidates,
} from "./scoring.js";
import { buildInjectedMemoryMessageContent, buildMemoryHeader, recentIds } from "./recall-utils.js";
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
const ELEVATED_USER_COLLECTION_PREFIX = "elevated:user:";
const ELEVATED_SESSION_COLLECTION_PREFIX = "elevated:session:";

export function buildContextEngineFactory(
  getRpc: RpcGetter,
  cfg: PluginConfig,
  recallCache: RecallCache<SearchResult>,
) {
  let authoredHardCache: SearchResult[] | null = null;
  let authoredSoftCache: SearchResult[] | null = null;
  let authoredVariantCache: SearchResult[] | null = null;

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
      const [authoredHard, authoredSoft, authoredVariantRecords] = await loadAuthoredCollections(rpc, {
        hard: authoredHardCache,
        soft: authoredSoftCache,
        variant: authoredVariantCache,
      });
      authoredHardCache = authoredHard;
      authoredSoftCache = authoredSoft;
      authoredVariantCache = authoredVariantRecords;
      validateSection7StartupHardReserve(cfg, authoredHard);
      return { ok: true };
    },
    async ingest({ sessionId, userId, message, isHeartbeat }: ContextIngestArgs) {
      if (isHeartbeat) {
        return { ingested: false };
      }

      const rpc = await getRpc();
      const ts = Date.now();
      const sessionMeta = {
        role: message.role,
        ts,
        userId,
        sessionId,
        type: "turn",
        provenance_class: "session_turn",
        stability_weight: stabilityWeightForMessage(message.role),
      };
      void rpc.call("insert_text", {
        collection: `session:${sessionId}`,
        id: `${sessionId}:${ts}`,
        text: message.content,
        metadata: sessionMeta,
      }).catch(console.error);

      if (message.role === "user") {
        try {
          recallCache.clearUser(userId);
          await rpc.call("insert_text", {
            collection: `turns:${userId}`,
            id: `${userId}:${ts}`,
            text: message.content,
            metadata: {
              ...sessionMeta,
              provenance_class: "turn_index",
            },
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
                role: message.role,
                ts,
                sessionId,
                type: "turn",
                userId,
                provenance_class: "durable_user_memory",
                stability_weight: Math.max(stabilityWeightForMessage(message.role), gating.g),
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
        const [authoredHard, authoredSoft, authoredVariantRecords] = await loadAuthoredCollections(rpc, {
          hard: authoredHardCache,
          soft: authoredSoftCache,
          variant: authoredVariantCache,
        });
        authoredHardCache = authoredHard;
        authoredSoftCache = authoredSoft;
        authoredVariantCache = authoredVariantRecords;

        const memoryBudget = tokenBudget * (cfg.tokenBudgetFraction ?? 0.25);
        const hardItems = authoredHard;
        const hardUsed = tokenCostSum(hardItems);
        const sessionRecords = await rpc.call<{ results: SearchResult[] }>("list_by_meta", {
          collection: `session:${sessionId}`,
          key: "sessionId",
          value: sessionId,
        });
        const rawSessionTurns = sortChronological(
          sessionRecords.results.filter((item) =>
            item.metadata.type !== "summary" && item.metadata.type !== "guidance_shard"
          ),
        );
        const minTurns = cfg.continuityMinTurns ?? DEFAULT_CONTINUITY_MIN_TURNS;
        const tailTarget = cfg.continuityTailBudgetTokens ?? DEFAULT_CONTINUITY_TAIL_BUDGET_TOKENS;
        const baseTail = selectRecentTail(rawSessionTurns, {
          minTurns,
          tailBudgetTokens: 0,
          tokenCost,
          sameBundle: isContinuityBundleCoupled,
        });
        const baseTailUsed = baseTail.baseTokens;
        const configuredHardFraction = clampFraction(cfg.authoredHardBudgetFraction);
        const hardBudget = configuredHardFraction > 0 ? memoryBudget * configuredHardFraction : hardUsed;
        const degradedReasons: string[] = [];
        if (hardUsed > hardBudget + 1e-9) {
          degradedReasons.push("hard authored invariants exceed configured hard budget reserve");
        }
        if (hardUsed + baseTailUsed > memoryBudget + 1e-9) {
          degradedReasons.push("hard authored invariants plus mandatory recent-tail base exceed available memory budget");
        }
        if (degradedReasons.length > 0) {
          const degradedTail = markRecentTail(baseTail.base, baseTail.base.length);
          const selected = [...hardItems, ...degradedTail];
          const selectedMessages = selected.map((item) => ({
            role: "system",
            content: buildInjectedMemoryMessageContent(item),
          }));
          return {
            messages: [...selectedMessages, ...messages],
            estimatedTokens: countTokens(selectedMessages) + countTokens(messages),
            systemPromptAddition: buildDegradedMemoryHeader(degradedReasons, selected),
          };
        }
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
          sameBundle: isContinuityBundleCoupled,
        });
        const recentTail = markRecentTail(
          recentTailSelection.recent,
          recentTailSelection.base.length,
        );
        const tailBaseItems = recentTail.slice(-recentTailSelection.base.length);
        const tailExtensionItems = recentTail.slice(0, Math.max(0, recentTail.length - recentTailSelection.base.length));
        const retrievalBudget = Math.max(0, memoryBudget - hardUsed - tokenCostSum(softItems) - tokenCostSum(recentTail));
        const recentTailIDs = recentTail.map((item) => item.id);

        const coarseTopK = Math.max(cfg.section7CoarseTopK ?? Math.max((cfg.topK ?? 8) * 2, 8), 1);
        const secondPassTopK = Math.max(cfg.section7SecondPassTopK ?? (cfg.topK ?? 8), 1);
        const [sessionHits, durableHits, elevatedHits] = await Promise.all([
          rpc.call<{ results: SearchResult[] }>("search_text", {
            collection: `session:${sessionId}`,
            text: queryText,
            k: coarseTopK,
            excludeIds: [...excluded, ...recentTailIDs],
          }),
          cached
            ? Promise.resolve({ results: cached.durableVariantHits })
            : rpc.call<{ results: SearchResult[] }>("search_text_collections", {
                collections: [`user:${userId}`, "global", AUTHORED_VARIANT_COLLECTION],
                text: queryText,
                k: coarseTopK,
                excludeByCollection: {},
              }),
          rpc.call<{ results: SearchResult[] }>("search_text_collections", {
            collections: [
              `${ELEVATED_USER_COLLECTION_PREFIX}${userId}`,
              `${ELEVATED_SESSION_COLLECTION_PREFIX}${sessionId}`,
            ],
            text: queryText,
            k: coarseTopK,
            excludeByCollection: {},
          }),
        ]);

        if (!cached) {
          recallCache.put({
            userId,
            queryText,
            durableVariantHits: durableHits.results,
          });
        }

        const ranked = rankSection7VariantCandidates(
          [
            ...annotateCollection(sessionHits.results, `session:${sessionId}`),
            ...elevatedHits.results,
            ...durableHits.results,
          ],
          {
            queryText,
            k1: coarseTopK,
            k2: secondPassTopK,
            theta1: cfg.section7Theta1,
            kappa: cfg.section7Kappa,
            authorityRecencyLambda: cfg.section7AuthorityRecencyLambda,
            authorityRecencyWeight: cfg.section7AuthorityRecencyWeight,
            authorityFrequencyWeight: cfg.section7AuthorityFrequencyWeight,
            authorityAuthoredWeight: cfg.section7AuthorityAuthoredWeight,
            sessionId,
            userId,
          },
        );
        const hopExpanded = expandSection7HopCandidates(
          ranked,
          annotateCollection(authoredVariantRecords, AUTHORED_VARIANT_COLLECTION),
          {
            etaHop: cfg.section7HopEta,
            thetaHop: cfg.section7HopThreshold,
          },
        );

        const mergedCandidates = mergeSection7VariantCandidates(ranked, hopExpanded);
        const elevatedGuidanceBudget = Math.max(
          0,
          Math.min(
            memoryBudget * (cfg.elevatedGuidanceBudgetFraction ?? 0.15),
            retrievalBudget,
          ),
        );
        const elevatedItems = fitPromptBudget(
          mergedCandidates.filter((item) => item.metadata.elevated_guidance === true),
          elevatedGuidanceBudget,
        );
        const remainingAfterElevated = Math.max(0, retrievalBudget - tokenCostSum(elevatedItems));
        const variantItems = fitPromptBudget(
          mergedCandidates.filter((item) => item.metadata.elevated_guidance !== true),
          remainingAfterElevated,
        );
        const selected = [
          ...hardItems,
          ...tailBaseItems,
          ...softItems,
          ...tailExtensionItems,
          ...elevatedItems,
          ...variantItems,
        ];
        void rpc.call("bump_access_counts", {
          updates: groupAccessCountUpdates([...elevatedItems, ...variantItems]),
        }).catch(() => {});

        const selectedMessages = selected.map((item) => ({
          role: "system",
          content: buildInjectedMemoryMessageContent(item),
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
        continuityPriorContextTokens: cfg.continuityPriorContextTokens ?? DEFAULT_CONTINUITY_PRIOR_CONTEXT_TOKENS,
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
  cached: { hard: SearchResult[] | null; soft: SearchResult[] | null; variant: SearchResult[] | null },
): Promise<[SearchResult[], SearchResult[], SearchResult[]]> {
  if (cached.hard && cached.soft && cached.variant) {
    return [
      sortAuthoredItems(cached.hard),
      sortAuthoredItems(cached.soft),
      sortAuthoredItems(cached.variant),
    ];
  }

  const [hard, soft, variant] = await Promise.all([
    cached.hard
      ? Promise.resolve({ results: cached.hard })
      : rpc.call<{ results: SearchResult[] }>("list_collection", { collection: AUTHORED_HARD_COLLECTION }),
    cached.soft
      ? Promise.resolve({ results: cached.soft })
      : rpc.call<{ results: SearchResult[] }>("list_collection", { collection: AUTHORED_SOFT_COLLECTION }),
    cached.variant
      ? Promise.resolve({ results: cached.variant })
      : rpc.call<{ results: SearchResult[] }>("list_collection", { collection: AUTHORED_VARIANT_COLLECTION }),
  ]);

  return [
    sortAuthoredItems(hard.results),
    sortAuthoredItems(soft.results),
    sortAuthoredItems(variant.results),
  ];
}

function tokenCostSum(items: SearchResult[]): number {
  return items.reduce((sum, item) => sum + tokenCost(item), 0);
}

function tokenCost(item: SearchResult): number {
  const estimate = item.metadata.token_estimate;
  if (typeof estimate === "number" && estimate > 0) {
    return estimate;
  }
  return estimateTokens(buildInjectedMemoryMessageContent(item));
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

function metadataNumber(item: SearchResult, key: string): number {
  const raw = item.metadata[key];
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

function annotateCollection(items: SearchResult[], collection: string): SearchResult[] {
  return items.map((item) => ({
    ...item,
    metadata: {
      ...item.metadata,
      collection,
    },
  }));
}

function sortAuthoredItems(items: SearchResult[]): SearchResult[] {
  return [...items].sort((left, right) => {
    const leftDoc = typeof left.metadata.source_doc === "string" ? left.metadata.source_doc : "";
    const rightDoc = typeof right.metadata.source_doc === "string" ? right.metadata.source_doc : "";
    if (leftDoc !== rightDoc) {
      return leftDoc.localeCompare(rightDoc);
    }

    const leftPosition = metadataNumber(left, "position");
    const rightPosition = metadataNumber(right, "position");
    if (leftPosition !== rightPosition) {
      return leftPosition - rightPosition;
    }

    const leftOrdinal = metadataNumber(left, "ordinal");
    const rightOrdinal = metadataNumber(right, "ordinal");
    if (leftOrdinal !== rightOrdinal) {
      return leftOrdinal - rightOrdinal;
    }

    return left.id.localeCompare(right.id);
  });
}

function groupAccessCountUpdates(items: SearchResult[]): Array<{ collection: string; ids: string[] }> {
  const grouped = new Map<string, string[]>();
  for (const item of items) {
    const collection = typeof item.metadata.collection === "string" ? item.metadata.collection : "";
    if (collection === "") {
      continue;
    }
    const ids = grouped.get(collection) ?? [];
    ids.push(item.id);
    grouped.set(collection, ids);
  }
  return [...grouped.entries()].map(([collection, ids]) => ({ collection, ids }));
}

function clampFraction(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function validateSection7StartupHardReserve(cfg: PluginConfig, authoredHard: SearchResult[]): void {
  if (authoredHard.length === 0) {
    return;
  }
  const hardFraction = clampFraction(cfg.authoredHardBudgetFraction);
  if (hardFraction <= 0) {
    return;
  }
  const startupTokenBudget = cfg.section7StartupTokenBudgetTokens;
  if (typeof startupTokenBudget !== "number" || !Number.isFinite(startupTokenBudget) || startupTokenBudget <= 0) {
    throw new Error(
      "section7StartupTokenBudgetTokens is required to validate the authored hard reserve at bootstrap when authoredHardBudgetFraction is configured",
    );
  }
  const memoryBudget = startupTokenBudget * (cfg.tokenBudgetFraction ?? 0.25);
  const hardBudget = memoryBudget * hardFraction;
  const hardUsed = tokenCostSum(authoredHard);
  if (hardUsed > hardBudget + 1e-9) {
    throw new Error(
      `authored hard invariants require ${hardUsed} tokens but the configured startup reserve allows only ${hardBudget}`,
    );
  }
}

function buildDegradedMemoryHeader(reasons: string[], selected: SearchResult[]): string {
  const header = [
    "<memory_degraded>",
    "Memory assembly is in degraded mode.",
    ...reasons.map((reason, idx) => `[D${idx + 1}] ${reason}.`),
    "Hard invariants and the mandatory recent-tail base were preserved without silent truncation.",
    "</memory_degraded>",
  ].join("\n");
  const body = buildMemoryHeader(selected);
  return body === "" ? header : `${header}\n\n${body}`;
}

function isContinuityBundleCoupled(left: SearchResult, right: SearchResult): boolean {
  const leftBundle = typeof left.metadata.continuity_bundle_id === "string" ? left.metadata.continuity_bundle_id : "";
  const rightBundle = typeof right.metadata.continuity_bundle_id === "string" ? right.metadata.continuity_bundle_id : "";
  if (leftBundle !== "" && leftBundle === rightBundle) {
    return true;
  }
  const leftRole = typeof left.metadata.role === "string" ? left.metadata.role : "";
  const rightRole = typeof right.metadata.role === "string" ? right.metadata.role : "";
  return (
    (leftRole === "user" && rightRole === "assistant") ||
    (leftRole === "assistant" && rightRole === "user")
  );
}

function stabilityWeightForMessage(role: string): number {
  switch (role) {
    case "user":
      return 0.5;
    case "assistant":
      return 0.25;
    default:
      return 0.2;
  }
}
