import { createHash } from "node:crypto";
import {
  DEFAULT_CONTINUITY_MIN_TURNS,
  DEFAULT_CONTINUITY_PRIOR_CONTEXT_TOKENS,
  DEFAULT_CONTINUITY_TAIL_BUDGET_TOKENS,
  selectRecentTail,
} from "./continuity.js";
import {
  detectRetrievalFailure,
  expandSection7HopCandidates,
  rankRawUserRecoveryCandidates,
  mergeSection7VariantCandidates,
  rankSection7VariantCandidates,
} from "./scoring.js";
import { buildInjectedMemoryMessageContent, buildMemoryHeader, recentIds } from "./recall-utils.js";
import { detectDreamQuerySignal, resolveDreamCollection } from "./dream-routing.js";
import {
  decideTemporalSelectorGuard,
  detectTemporalQuerySignal,
  rankTemporalRecoveryCandidates,
} from "./temporal.js";
import type { TemporalRecoveryRankingResult } from "./temporal.js";
import { countTokens, estimateTokens, fitPromptBudget, fitPromptBudgetFirstFit } from "./tokens.js";
import { resolveDurableNamespace } from "./durable-namespace.js";
import type { RpcGetter } from "./plugin-runtime.js";
import type {
  ContextAssembleArgs,
  ContextAssembleResult,
  ContextBootstrapArgs,
  ContextCompactArgs,
  ContextIngestArgs,
  GatingResult,
  MemoryMessage,
  PluginConfig,
  RecallCache,
  SearchResult,
} from "./types.js";

const AUTHORED_HARD_COLLECTION = "authored:hard";
const AUTHORED_SOFT_COLLECTION = "authored:soft";
const AUTHORED_VARIANT_COLLECTION = "authored:variant";
const ELEVATED_USER_COLLECTION_PREFIX = "elevated:user:";
const ELEVATED_SESSION_COLLECTION_PREFIX = "elevated:session:";
const SESSION_RECALL_COLLECTION_PREFIX = "session_recall:";
const SESSION_RAW_COLLECTION_PREFIX = "session_raw:";
const SESSION_SUMMARY_COLLECTION_PREFIX = "session_summary:";
const SESSION_EDGE_COLLECTION_PREFIX = "session_edge:";
const SESSION_STATE_COLLECTION_PREFIX = "session_state:";
const AFTER_TURN_DEDUPE_TTL_MS = 60 * 60 * 1000;
const AFTER_TURN_DEDUPE_MAX_ENTRIES = 1024;

export function buildContextEngineFactory(
  getRpc: RpcGetter,
  cfg: PluginConfig,
  recallCache: RecallCache<SearchResult>,
) {
  let authoredHardCache: SearchResult[] | null = null;
  let authoredSoftCache: SearchResult[] | null = null;
  let authoredVariantCache: SearchResult[] | null = null;
  const authoredVariantRecallCache = new Map<string, SearchResult[]>();
  const afterTurnIngestedKeys = new Map<string, number>();

  // Session-scoped elevated-guidance cache keyed by sessionId + generation + durable namespace + queryText
  const elevatedRecallCache = new Map<string, SearchResult[]>();
  const elevatedRecallGeneration = new Map<string, number>();

  function clearElevatedCacheForSession(sessionId: string) {
    const nextGeneration = (elevatedRecallGeneration.get(sessionId) ?? 0) + 1;
    elevatedRecallGeneration.set(sessionId, nextGeneration);
  }

  return {
    info: { id: "libravdb-memory", name: "LibraVDB Memory", ownsCompaction: true },
    ownsCompaction: true,
    async bootstrap({ sessionId, sessionKey, userId }: ContextBootstrapArgs) {
      const durableNamespace = resolveDurableNamespace({ userId, sessionKey, fallback: `session:${sessionId}` });
      const rpc = await getRpc();
      await rpc.call("ensure_collections", {
        collections: [
          `session:${sessionId}`,
          sessionRawCollection(sessionId),
          sessionSummaryCollection(sessionId),
          sessionEdgeCollection(sessionId),
          sessionStateCollection(sessionId),
          ...(useSessionRecallProjection(cfg) ? [sessionRecallCollection(sessionId)] : []),
          `turns:${durableNamespace}`,
          `user:${durableNamespace}`,
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
      authoredVariantRecallCache.clear();
      if (useSessionRecallProjection(cfg)) {
        await rebuildSessionRecallProjection(rpc, cfg, sessionId);
      }
      validateSection7StartupHardReserve(cfg, authoredHard);
      return { ok: true };
    },
    async ingest({ sessionId, sessionKey, userId, message, isHeartbeat }: ContextIngestArgs) {
      if (isHeartbeat) {
        return { ingested: false };
      }

      const result = await ingestCanonicalMessage({
        getRpc,
        cfg,
        recallCache,
        clearElevatedCacheForSession,
        sessionId,
        sessionKey,
        userId,
        message,
      });
      return { ingested: result.ingested };
    },
    async afterTurn({ sessionId, sessionKey, userId, messages, prePromptMessageCount, isHeartbeat }: {
      sessionId: string;
      sessionKey?: string;
      userId?: string;
      messages: Array<{ role: string; content: unknown }>;
      prePromptMessageCount: number;
      isHeartbeat?: boolean;
    }) {
      if (isHeartbeat) {
        return;
      }

      const startIndex = Math.max(0, prePromptMessageCount - 1);
      const turnMessages = messages.slice(startIndex);
      const normalizedTurnMessages = turnMessages.flatMap((turnMessage, offset) => {
        const normalized = normalizeHostMessage(turnMessage);
        if (!normalized) {
          return [];
        }
        return [{ index: startIndex + offset, normalized }] as const;
      });
      for (let offset = 0; offset < normalizedTurnMessages.length; offset++) {
        const { index, normalized } = normalizedTurnMessages[offset];

        const dedupeKey = `${sessionId}\n${index}\n${normalized.role}\n${hashMessageContent(normalized.content)}`;
        if (hasRecentAfterTurnIngest(afterTurnIngestedKeys, dedupeKey)) {
          continue;
        }

        const result = await ingestCanonicalMessage({
          getRpc,
          cfg,
          recallCache,
          clearElevatedCacheForSession,
          sessionId,
          sessionKey,
          userId,
          message: {
            ...normalized,
            id: `after-turn:${index}`,
          },
          skipProjectionRebuild: offset !== normalizedTurnMessages.length - 1,
        });
        if (result.ingested) {
          rememberAfterTurnIngest(afterTurnIngestedKeys, dedupeKey);
        }
      }
    },
    async assemble({ sessionId, sessionKey, userId, messages, tokenBudget, ...rest }: ContextAssembleArgs & Record<string, unknown>) {
      const PROFILE = process.env.OPENCLAW_PROFILE_ASSEMBLE === "1";
      const DEBUG_RECOVERY = process.env.LONGMEMEVAL_DEBUG_RANKING === "1";
      const durableNamespace = resolveDurableNamespace({ userId, sessionKey, fallback: `session:${sessionId}` });
      const originalMessages = messages;
      const normalizedMessages = normalizeConversationMessages(messages as Array<{ role: string; content: unknown }>);

      const queryText =
        (typeof rest.prompt === "string" && rest.prompt.trim() ? rest.prompt : undefined) ??
        normalizedMessages.at(-1)?.content ?? "";
      if (!queryText) {
        return {
          messages: originalMessages,
          estimatedTokens: countTokens(originalMessages),
          systemPromptAddition: "",
        } satisfies ContextAssembleResult;
      }
      const dreamQuery = detectDreamQuerySignal(queryText);
      const temporalQuery = detectTemporalQuerySignal(queryText);
      const temporalSelectorGuard = decideTemporalSelectorGuard(queryText, temporalQuery);

      const excluded = recentIds(normalizedMessages, 4);
      const cached = dreamQuery.active ? undefined : recallCache.take({ userId: durableNamespace, queryText });

      const rpc = await getRpc();

      // Use cached authored collections directly if available (bootstrap-loaded and sorted)
      // Only load as fallback if caches are unexpectedly null
      let authoredHard = authoredHardCache;
      let authoredSoft = authoredSoftCache;
      let authoredVariantRecords = authoredVariantCache;
      if (!authoredHard || !authoredSoft || !authoredVariantRecords) {
        const [loadedHard, loadedSoft, loadedVariant] = await loadAuthoredCollections(rpc, {
          hard: authoredHardCache,
          soft: authoredSoftCache,
          variant: authoredVariantCache,
        });
        authoredHard = loadedHard;
        authoredSoft = loadedSoft;
        authoredVariantRecords = loadedVariant;
        authoredHardCache = loadedHard;
        authoredSoftCache = loadedSoft;
        authoredVariantCache = loadedVariant;
      }

      // Profiler: null when disabled (zero overhead), object when enabled
      const profiler = PROFILE
        ? (() => {
            const marks: Array<[string, bigint]> = [];
            return {
              mark(label: string) {
                marks.push([label, process.hrtime.bigint()]);
              },
              lines() {
                const lines: string[] = [];
                for (let i = 0; i < marks.length - 1; i++) {
                  const [name, start] = marks[i];
                  const [, end] = marks[i + 1];
                  const ms = Number(end - start) / 1_000_000;
                  lines.push(`assemble profile: ${name}=${ms.toFixed(2)}ms`);
                }
                return lines;
              },
              emit() {
                for (const line of this.lines()) {
                  console.log(line);
                }
              },
            };
          })()
        : null;

      try {
        const result = await this.assembleCore({
          rpc,
          cfg,
          recallCache,
          authoredHard,
          authoredSoft,
          authoredVariantRecords,
          cached,
          excluded,
          queryText,
          dreamQuery,
          temporalQuery,
          temporalSelectorGuard,
          sessionId,
          userId: durableNamespace,
          visibleMessages: originalMessages,
          messages: normalizedMessages,
          tokenBudget,
          profiler,
          debugRecovery: DEBUG_RECOVERY,
        });

        const profileLines = profiler?.lines() ?? [];
        if (profiler) {
          profiler.emit();
        }

        return profileLines.length > 0
          ? { ...result, _profile: profileLines }
          : result;
      } catch {
        return {
          messages: originalMessages,
          estimatedTokens: countTokens(originalMessages),
          systemPromptAddition: "",
        } satisfies ContextAssembleResult;
      }
    },
    async assembleCore({
      rpc,
      cfg,
      recallCache,
      authoredHard,
      authoredSoft,
      authoredVariantRecords,
      cached,
      excluded,
      queryText,
      dreamQuery,
      temporalQuery,
      temporalSelectorGuard,
      sessionId,
      userId,
      visibleMessages,
      messages,
      tokenBudget,
      profiler,
      debugRecovery,
    }: {
      rpc: Awaited<ReturnType<RpcGetter>>;
      cfg: PluginConfig;
      recallCache: RecallCache<SearchResult>;
      authoredHard: SearchResult[];
      authoredSoft: SearchResult[];
      authoredVariantRecords: SearchResult[];
      cached: ReturnType<RecallCache<SearchResult>["take"]>;
      excluded: string[];
      queryText: string;
      dreamQuery: ReturnType<typeof detectDreamQuerySignal>;
      temporalQuery: ReturnType<typeof detectTemporalQuerySignal>;
      temporalSelectorGuard: ReturnType<typeof decideTemporalSelectorGuard>;
      sessionId: string;
      userId: string;
      visibleMessages: MemoryMessage[];
      messages: Array<{ role: string; content: string }>;
      tokenBudget: number;
      profiler: { mark(label: string): void; emit(): void } | null;
      debugRecovery: boolean;
    }): Promise<ContextAssembleResult> {
      const memoryBudget = tokenBudget * (cfg.tokenBudgetFraction ?? 0.25);
      const hardItems = authoredHard;
      const hardUsed = tokenCostSum(hardItems);
      const dreamMode = dreamQuery.active;
      const dreamCollection = resolveDreamCollection(userId);

      if (dreamMode) {
        const authoredSoftTarget = Math.max(0, memoryBudget * (cfg.authoredSoftBudgetFraction ?? 0.3));
        const softBudget = Math.max(0, Math.min(authoredSoftTarget, memoryBudget - hardUsed));
        const softItems = fitPromptBudget(authoredSoft, softBudget);
        const remainingBudget = Math.max(0, memoryBudget - hardUsed - tokenCostSum(softItems));

        profiler?.mark("dream_search");
        const dreamTopK = Math.max(cfg.topK ?? 8, 1);
        const dreamHits = await rpc.call<{ results: SearchResult[] }>("search_text", {
          collection: dreamCollection,
          text: queryText,
          k: dreamTopK,
        });

        profiler?.mark("dream_rank");
        const rankedDream = rankSection7VariantCandidates(
          annotateCollection(dreamHits.results ?? [], dreamCollection),
          {
            queryText,
            k1: dreamTopK,
            k2: dreamTopK,
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
        const dreamItems = fitPromptBudget(rankedDream, remainingBudget);
        const selected = [...hardItems, ...softItems, ...dreamItems];
        const selectedMessages = selected.map((item) => ({
          role: "system",
          content: buildInjectedMemoryMessageContent(item),
        }));
        return {
          messages: [...selectedMessages, ...visibleMessages],
          estimatedTokens: countTokens(selectedMessages) + countTokens(visibleMessages),
          systemPromptAddition: buildMemoryHeader(selected),
        };
      }

      profiler?.mark("session");
      const sessionRecords = await rpc.call<{ results: SearchResult[] }>("list_by_meta", {
        collection: `session:${sessionId}`,
        key: "sessionId",
        value: sessionId,
      });
      const rawSessionTurns = sortChronological(
        sessionRecords.results.filter((item) =>
          // cascade_tier is ranking metadata (cascade search tier); exclude from session history
          item.metadata.type !== "summary" &&
          item.metadata.type !== "guidance_shard" &&
          typeof item.metadata.cascade_tier !== "number"
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
          messages: [...selectedMessages, ...visibleMessages],
          estimatedTokens: countTokens(selectedMessages) + countTokens(visibleMessages),
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
      const sessionSearchTopK = Math.max(cfg.topK ?? 8, 1);
      const secondPassTopK = Math.max(cfg.section7SecondPassTopK ?? (cfg.topK ?? 8), 1);
      const searchSessionRecall = useSessionRecallProjection(cfg);
      const searchSessionSummary = useSessionSummarySearchExperiment(cfg);
      let sessionSearchCollection = `session:${sessionId}`;
      let sessionExcludeIds = [...excluded, ...recentTailIDs];
      if (dreamMode) {
        sessionSearchCollection = dreamCollection;
        sessionExcludeIds = [...excluded];
      } else if (searchSessionSummary) {
        const summaryCollection = sessionSummaryCollection(sessionId);
        const summaryRecords = await rpc.call<{ results: SearchResult[] }>("list_collection", {
          collection: summaryCollection,
        });
        if (summaryRecords.results.length > 0) {
          sessionSearchCollection = summaryCollection;
          sessionExcludeIds = [...excluded];
        }
      } else if (searchSessionRecall) {
        sessionSearchCollection = sessionRecallCollection(sessionId);
        sessionExcludeIds = [...excluded, ...recentTailIDs.map(sessionRecallId)];
      }

      profiler?.mark("session_search");
      const [sessionHits] = await Promise.all([
        rpc.call<{ results: SearchResult[] }>("search_text", {
          collection: sessionSearchCollection,
          text: queryText,
          k: sessionSearchTopK,
          excludeIds: sessionExcludeIds,
        }),
      ]);

      profiler?.mark("recall_user_global");
      const [userHits, globalHits] = await Promise.all([
        dreamMode
          ? Promise.resolve({ results: [] as SearchResult[] })
          : cached?.userHits
          ? Promise.resolve({ results: cached.userHits })
          : rpc.call<{ results: SearchResult[] }>("search_text", {
              collection: `user:${userId}`,
              text: queryText,
              k: Math.ceil((cfg.topK ?? 8) / 2),
            }),
        dreamMode
          ? Promise.resolve({ results: [] as SearchResult[] })
          : cached?.globalHits
          ? Promise.resolve({ results: cached.globalHits })
          : rpc.call<{ results: SearchResult[] }>("search_text", {
              collection: "global",
              text: queryText,
              k: Math.ceil((cfg.topK ?? 8) / 4),
            }),
      ]);

      if (!cached && !dreamMode) {
        recallCache.put({
          userId,
          queryText,
          durableVariantHits: [],
          userHits: userHits.results,
          globalHits: globalHits.results,
        });
      }

      profiler?.mark("recall_authored_variant");
      const authoredVariantKey = `${queryText}\n${coarseTopK}`;
      const cachedAuthoredVariantHits = authoredVariantRecallCache.get(authoredVariantKey);
      const [authoredVariantHits] = await Promise.all([
        dreamMode
          ? Promise.resolve({ results: [] as SearchResult[] })
          : cachedAuthoredVariantHits
          ? Promise.resolve({ results: cachedAuthoredVariantHits })
          : rpc.call<{ results: SearchResult[] }>("search_text", {
              collection: AUTHORED_VARIANT_COLLECTION,
              text: queryText,
              k: coarseTopK,
            }),
      ]);
      if (!cachedAuthoredVariantHits) {
        authoredVariantRecallCache.set(authoredVariantKey, authoredVariantHits.results);
      }

      profiler?.mark("recall_elevated");
      const elevatedGeneration = elevatedRecallGeneration.get(sessionId) ?? 0;
      const elevatedKey = `${sessionId}\n${elevatedGeneration}\n${userId}\n${queryText}`;
      const cachedElevated = elevatedRecallCache.get(elevatedKey);
      const [elevatedHits] = await Promise.all([
        dreamMode
          ? Promise.resolve({ results: [] as SearchResult[] })
          : cachedElevated
          ? Promise.resolve({ results: cachedElevated })
          : rpc.call<{ results: SearchResult[] }>("search_text_collections", {
              collections: [
                `${ELEVATED_USER_COLLECTION_PREFIX}${userId}`,
                `${ELEVATED_SESSION_COLLECTION_PREFIX}${sessionId}`,
              ],
              text: queryText,
              k: coarseTopK,
              excludeByCollection: {},
            }),
      ]);
      if (!cachedElevated) {
        elevatedRecallCache.set(elevatedKey, elevatedHits.results);
      }

      profiler?.mark("rank");
      const ranked = rankSection7VariantCandidates(
        [
          ...annotateCollection(sessionHits.results, sessionSearchCollection),
          ...elevatedHits.results,
          ...userHits.results,
          ...globalHits.results,
          ...authoredVariantHits.results,
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

      profiler?.mark("hop");
      const hopExpanded = expandSection7HopCandidates(
        ranked,
        annotateCollection(authoredVariantRecords, AUTHORED_VARIANT_COLLECTION),
        {
          etaHop: cfg.section7HopEta,
          thetaHop: cfg.section7HopThreshold,
        },
      );

      profiler?.mark("fit");
      const mergedCandidates = mergeSection7VariantCandidates(ranked, hopExpanded);
      // Recovery trigger is evaluated before variant fitting so healthy sessions
      // do not lose recall budget to an unused recovery reserve.
      profiler?.mark("recovery_trigger");
      const recoveryTrigger = dreamMode
        ? {
            signal1CascadeTier3: false,
            signal2TopScoreBelowFloor: false,
            signal3AllSummariesLowConfidence: false,
            fire: false,
          }
        : detectRetrievalFailure(mergedCandidates, {
            floorScore: cfg.recoveryFloorScore ?? 0.15,
            minTopK: cfg.recoveryMinTopK ?? 4,
            meanConfidenceThresh: cfg.recoveryMinConfidenceMean ?? 0.5,
          });
      const crossSessionRawRecovery = !dreamMode &&
        rawSessionTurns.length === 0 &&
        sessionHits.results.length === 0;
      const recoveryReserveTokens = (recoveryTrigger.fire || crossSessionRawRecovery)
        ? Math.min(memoryBudget, Math.max(Math.floor(memoryBudget * 0.10), 16), 128)
        : 0;
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
      const remainingForVariant = Math.max(0, remainingAfterElevated - recoveryReserveTokens);
      const variantItems = fitPromptBudget(
        mergedCandidates.filter((item) => item.metadata.elevated_guidance !== true),
        remainingForVariant,
      );

      // Build set of theorem-selected IDs for recovery deduplication.
      // Recovery should only append NEW raw evidence, not re-inject content already
      // selected by the normal assembly path (hard/soft/tail/elevated/variant).
      const theoremSelectedIDs = new Set([
        ...hardItems.map((i) => i.id),
        ...softItems.map((i) => i.id),
        ...tailBaseItems.map((i) => i.id),
        ...tailExtensionItems.map((i) => i.id),
        ...elevatedItems.map((i) => i.id),
        ...variantItems.map((i) => i.id),
      ]);

      // Recovery is a policy overlay — it appends raw content only when triggered,
      // it never modifies the C_total(q) output and does not spend from tau_V.
      let recoveryItems: SearchResult[] = [];
      let rawUserRecoveryDebug: NonNullable<NonNullable<ContextAssembleResult["_debug"]>["rawUserRecoveryCandidates"]> = [];
      let temporalRecoveryResult: TemporalRecoveryRankingResult | null = null;
      if (!dreamMode && (recoveryTrigger.fire || crossSessionRawRecovery)) {
        profiler?.mark("recovery_expand");
        const recoveryExcludeIDs = [...excluded, ...recentTailIDs, ...theoremSelectedIDs];
        const recoveryCandidates: SearchResult[] = [];

        if (recoveryTrigger.fire) {
          // Recovery searches immutable raw session history directly — never the active view,
          // elevated shards, or authored collections.
          const rawResults = await rpc.call<{ results: SearchResult[] }>("query_raw_session", {
            sessionId,
            text: queryText,
            k: Math.max(cfg.topK ?? 8, 4),
            excludeIds: recoveryExcludeIDs,
          });
          recoveryCandidates.push(
            ...(rawResults.results ?? []).map((item) => ({
              ...item,
              finalScore: typeof item.finalScore === "number" ? item.finalScore : item.score,
              metadata: {
                ...item.metadata,
                recovery_fallback: true,
                recovery_scope: "session_raw",
              },
            })),
          );
        }

        if (crossSessionRawRecovery) {
          // When a fresh query session has no searchable history yet, durable memory can be too
          // coarse for exact-turn recall. Search the immutable per-user raw turn index instead of
          // widening topK so precise historical turns still have a bounded path back into context.
          const rawUserResults = await rpc.call<{ results: SearchResult[] }>("search_text", {
            collection: `turns:${userId}`,
            text: queryText,
            k: Math.max((cfg.topK ?? 8) * 4, 8),
            excludeIds: recoveryExcludeIDs,
          });
          const annotatedUserResults = annotateCollection(rawUserResults.results ?? [], `turns:${userId}`);
          temporalRecoveryResult = temporalSelectorGuard.shouldApply
            ? rankTemporalRecoveryCandidates(annotatedUserResults, {
                queryText,
                maxSelected: 3,
                nowMs: Date.now(),
                recencyLambda: cfg.recencyLambdaUser ?? 0.00001,
              })
            : null;
          const reranked = temporalRecoveryResult
            ? temporalRecoveryResult
            : rankRawUserRecoveryCandidates(annotatedUserResults, { queryText });
          if (debugRecovery) {
            rawUserRecoveryDebug = reranked.debug.slice(0, 8).map((item) => ({
              id: item.id,
              text: item.text,
              selected: false,
              tokenEstimate: estimateTokens(item.text),
              temporalAnchorDensity: "temporalAnchorDensity" in item && typeof item.temporalAnchorDensity === "number"
                ? item.temporalAnchorDensity
                : 0,
              semanticScore: "semanticScore" in item && typeof item.semanticScore === "number"
                ? item.semanticScore
                : 0,
              slotCoverage: "slotCoverage" in item && typeof item.slotCoverage === "number"
                ? item.slotCoverage
                : undefined,
              slotMatches: "slotMatches" in item && Array.isArray(item.slotMatches)
                ? item.slotMatches
                : undefined,
              lexicalCoverage: "lexicalCoverage" in item && typeof item.lexicalCoverage === "number"
                ? item.lexicalCoverage
                : ("slotCoverage" in item && typeof item.slotCoverage === "number" ? item.slotCoverage : 0),
              recencyScore: "recencyScore" in item && typeof item.recencyScore === "number"
                ? item.recencyScore
                : 0,
              finalScore: typeof item.finalScore === "number" ? item.finalScore : 0,
              rationale: typeof item.rationale === "string" ? item.rationale : "",
            }));
          }
          recoveryCandidates.push(
            ...reranked.ranked.map((item) => ({
              ...item,
              finalScore: typeof item.finalScore === "number" ? item.finalScore : item.score,
              metadata: {
                ...item.metadata,
                recovery_fallback: true,
                recovery_scope: "user_turns",
              },
            })),
          );
        }

        const fittedRecovery = fitPromptBudgetFirstFit(
          dedupeRecoveryCandidates(recoveryCandidates),
          recoveryReserveTokens,
        );
        recoveryItems = fittedRecovery;
        if (debugRecovery && rawUserRecoveryDebug.length > 0) {
          const selectedIDs = new Set(
            fittedRecovery
              .filter((item) => item.metadata.recovery_scope === "user_turns")
              .map((item: SearchResult) => item.id),
          );
          rawUserRecoveryDebug = rawUserRecoveryDebug.map((item) => ({
            ...item,
            selected: selectedIDs.has(item.id),
          }));
        }
      }

      const selected = [
        ...hardItems,
        ...tailBaseItems,
        ...softItems,
        ...tailExtensionItems,
        ...elevatedItems,
        ...variantItems,
        ...recoveryItems,
      ];
      void rpc.call("bump_access_counts", {
        updates: groupAccessCountUpdates([...elevatedItems, ...variantItems]),
      }).catch(() => {});

      profiler?.mark("render");
      const selectedMessages = selected.map((item) => ({
        role: "system",
        content: buildInjectedMemoryMessageContent(item),
      }));

      return {
        messages: [...selectedMessages, ...visibleMessages],
        estimatedTokens: countTokens(selectedMessages) + countTokens(visibleMessages),
        systemPromptAddition: buildMemoryHeader(selected),
        _debug: debugRecovery
          ? {
              recoveryTriggerFired: recoveryTrigger.fire,
              crossSessionRawRecovery,
              recoveryReserveTokens,
              temporalQueryIndicator: temporalQuery.indicator,
              temporalQueryActive: temporalQuery.active,
              temporalQueryPatterns: temporalQuery.matchedPatterns,
              temporalSelectorApplied: temporalSelectorGuard.shouldApply,
              temporalSelectorReason: temporalSelectorGuard.reason,
              temporalRecoverySlots: temporalRecoveryResult?.slots,
              rawUserRecoveryCandidates: rawUserRecoveryDebug,
            }
          : undefined,
      };
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
      if (compacted && useSessionRecallProjection(cfg)) {
        await rebuildSessionRecallProjection(rpc, cfg, sessionId);
      }

      return {
        ok: true,
        compacted,
      };
    },
  };
}

function useSessionRecallProjection(cfg: PluginConfig): boolean {
  return cfg.useSessionRecallProjection === true;
}

function useSessionSummarySearchExperiment(cfg: PluginConfig): boolean {
  return cfg.useSessionSummarySearchExperiment === true;
}

function sessionRecallCollection(sessionId: string): string {
  return `${SESSION_RECALL_COLLECTION_PREFIX}${sessionId}`;
}

function sessionRawCollection(sessionId: string): string {
  return `${SESSION_RAW_COLLECTION_PREFIX}${sessionId}`;
}

function sessionSummaryCollection(sessionId: string): string {
  return `${SESSION_SUMMARY_COLLECTION_PREFIX}${sessionId}`;
}

function sessionEdgeCollection(sessionId: string): string {
  return `${SESSION_EDGE_COLLECTION_PREFIX}${sessionId}`;
}

function sessionStateCollection(sessionId: string): string {
  return `${SESSION_STATE_COLLECTION_PREFIX}${sessionId}`;
}

function sessionRecallId(sourceId: string): string {
  return `recall:${sourceId}`;
}

async function rebuildSessionRecallProjection(
  rpc: Awaited<ReturnType<RpcGetter>>,
  cfg: PluginConfig,
  sessionId: string,
): Promise<void> {
  const rawCollection = `session:${sessionId}`;
  const projectionCollection = sessionRecallCollection(sessionId);
  const sessionRecords = await rpc.call<{ results: SearchResult[] }>("list_by_meta", {
    collection: rawCollection,
    key: "sessionId",
    value: sessionId,
  });
  const rawSessionTurns = sortChronological(
    sessionRecords.results.filter((item) =>
      // cascade_tier is ranking metadata (cascade search tier); exclude from session history
      item.metadata.type !== "summary" &&
      item.metadata.type !== "guidance_shard" &&
      typeof item.metadata.cascade_tier !== "number"
    ),
  );
  const recentTail = selectRecentTail(rawSessionTurns, {
    minTurns: cfg.continuityMinTurns ?? DEFAULT_CONTINUITY_MIN_TURNS,
    tailBudgetTokens: cfg.continuityTailBudgetTokens ?? DEFAULT_CONTINUITY_TAIL_BUDGET_TOKENS,
    tokenCost,
    sameBundle: isContinuityBundleCoupled,
  });
  const projectionItems = recentTail.older;
  const existingProjection = await rpc.call<{ results: SearchResult[] }>("list_collection", {
    collection: projectionCollection,
  });
  const existingIds = existingProjection.results
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (existingIds.length > 0) {
    await rpc.call("delete_batch", {
      collection: projectionCollection,
      ids: existingIds,
    });
  }
  await Promise.all(projectionItems.map((item) =>
    rpc.call("insert_text", {
      collection: projectionCollection,
      id: sessionRecallId(item.id),
      score: item.score,
      text: item.text,
      metadata: {
        ...item.metadata,
        projection_class: "session_recall",
        source_turn_id: item.id,
        source_turn_ts: metadataTimestamp(item),
      },
    })
  ));
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

function dedupeRecoveryCandidates(items: SearchResult[]): SearchResult[] {
  const byKey = new Map<string, SearchResult>();
  for (const item of items) {
    const collection = typeof item.metadata.collection === "string" ? item.metadata.collection : "";
    const key = `${collection}::${item.id}`;
    const existing = byKey.get(key);
    if (!existing || (item.finalScore ?? item.score) > (existing.finalScore ?? existing.score)) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()].sort((left, right) => (right.finalScore ?? right.score) - (left.finalScore ?? left.score));
}

function clampFraction(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

async function ingestCanonicalMessage(params: {
  getRpc: RpcGetter;
  cfg: PluginConfig;
  recallCache: RecallCache<SearchResult>;
  clearElevatedCacheForSession: (sessionId: string) => void;
  sessionId: string;
  sessionKey?: string;
  userId?: string;
  message: MemoryMessage;
  skipProjectionRebuild?: boolean;
}): Promise<{ ingested: boolean }> {
  const normalized = normalizeMemoryMessage(params.message);
  if (!normalized) {
    return { ingested: false };
  }

  const rpc = await params.getRpc();
  const ts = Date.now();
  const durableNamespace = resolveDurableNamespace({
    userId: params.userId,
    sessionKey: params.sessionKey,
    fallback: `session:${params.sessionId}`,
  });
  const turnId = normalized.id ?? `${ts}`;
  const sessionMeta = {
    role: normalized.role,
    ts,
    userId: durableNamespace,
    sessionId: params.sessionId,
    type: "turn",
    provenance_class: "session_turn",
    stability_weight: stabilityWeightForMessage(normalized.role),
    source_turn_id: turnId,
  };

  params.clearElevatedCacheForSession(params.sessionId);
  const rawSessionInsert = rpc.call("insert_session_turn", {
    sessionId: params.sessionId,
    id: `${params.sessionId}:${turnId}`,
    text: normalized.content,
    metadata: sessionMeta,
  });
  try {
    await rawSessionInsert;
    if (useSessionRecallProjection(params.cfg) && !params.skipProjectionRebuild) {
      await rebuildSessionRecallProjection(rpc, params.cfg, params.sessionId);
    }
  } catch {
    return { ingested: false };
  }

  if (normalized.role !== "user") {
    return { ingested: true };
  }

  try {
    params.recallCache.clearUser(durableNamespace);
    await rpc.call("insert_text", {
      collection: `turns:${durableNamespace}`,
      id: `${durableNamespace}:${turnId}`,
      text: normalized.content,
      metadata: {
        ...sessionMeta,
        provenance_class: "turn_index",
      },
    });

    const gating = await rpc.call<GatingResult>("gating_scalar", {
      userId: durableNamespace,
      text: normalized.content,
    });

    if (gating.g >= (params.cfg.ingestionGateThreshold ?? 0.35)) {
      void rpc.call("insert_text", {
        collection: `user:${durableNamespace}`,
        id: `${durableNamespace}:${turnId}`,
        text: normalized.content,
        metadata: {
          role: normalized.role,
          ts,
          sessionId: params.sessionId,
          type: "turn",
          userId: durableNamespace,
          source_turn_id: turnId,
          provenance_class: "durable_user_memory",
          stability_weight: Math.max(stabilityWeightForMessage(normalized.role), gating.g),
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

  return { ingested: true };
}

function hashMessageContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function pruneAfterTurnIngestKeys(cache: Map<string, number>, now: number): void {
  for (const [key, seenAt] of cache) {
    if (now - seenAt > AFTER_TURN_DEDUPE_TTL_MS) {
      cache.delete(key);
    }
  }
  while (cache.size > AFTER_TURN_DEDUPE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    cache.delete(oldestKey);
  }
}

function hasRecentAfterTurnIngest(cache: Map<string, number>, key: string): boolean {
  const now = Date.now();
  pruneAfterTurnIngestKeys(cache, now);
  return cache.has(key);
}

function rememberAfterTurnIngest(cache: Map<string, number>, key: string): void {
  const now = Date.now();
  cache.delete(key);
  cache.set(key, now);
  pruneAfterTurnIngestKeys(cache, now);
}

function normalizeHostMessage(message: { role: string; content: unknown } | undefined): MemoryMessage | null {
  if (!message || !shouldIngestRole(message.role)) {
    return null;
  }
  const content = extractMessageText(message.content);
  if (!content) {
    return null;
  }
  return {
    role: message.role,
    content,
  };
}

function normalizeConversationMessages(messages: Array<{ role: string; content: unknown }>): MemoryMessage[] {
  return messages
    .map((message) => normalizeHostMessage(message))
    .filter((message): message is MemoryMessage => message !== null);
}

function normalizeMemoryMessage(message: MemoryMessage): MemoryMessage | null {
  if (!shouldIngestRole(message.role)) {
    return null;
  }
  const content = extractMessageText(message.content);
  if (!content) {
    return null;
  }
  return {
    ...message,
    content,
  };
}

function shouldIngestRole(role: string): boolean {
  return role === "user" || role === "assistant" || role === "system";
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }
      const type = (part as { type?: unknown }).type;
      if (
        (type === "text" || type === "input_text" || type === "output_text") &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return [(part as { text: string }).text];
      }
      return [];
    })
    .join("\n")
    .trim();
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
