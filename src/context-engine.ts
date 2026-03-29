import { scoreCandidates } from "./scoring.js";
import { buildMemoryHeader, recentIds } from "./recall-utils.js";
import { countTokens, fitPromptBudget } from "./tokens.js";
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

export function buildContextEngineFactory(
  getRpc: RpcGetter,
  cfg: PluginConfig,
  recallCache: RecallCache<SearchResult>,
) {
  return {
    ownsCompaction: true,
    async bootstrap({ sessionId, userId }: ContextBootstrapArgs) {
      const rpc = await getRpc();
      await rpc.call("ensure_collections", {
        collections: [`session:${sessionId}`, `turns:${userId}`, `user:${userId}`, "global"],
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
      const cached = recallCache.take({ userId, queryText });

      try {
        const rpc = await getRpc();
        const [sessionHits, userHits, globalHits] = await Promise.all([
          rpc.call<{ results: SearchResult[] }>("search_text", {
            collection: `session:${sessionId}`,
            text: queryText,
            k: cfg.topK ?? 8,
            excludeIds: excluded,
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
        ]);

        const ranked = scoreCandidates(
          [
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

        const selected = fitPromptBudget(
          ranked,
          tokenBudget * (cfg.tokenBudgetFraction ?? 0.25),
        );

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
