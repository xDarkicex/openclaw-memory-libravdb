import { buildMemoryHeader } from "./recall-utils.js";
import { fitPromptBudget } from "./tokens.js";
import { scoreCandidates } from "./scoring.js";
import type { RpcGetter } from "./plugin-runtime.js";
import type { MemoryMessage, PluginConfig, RecallCache, SearchResult } from "./types.js";

export function buildMemoryPromptSection(
  getRpc: RpcGetter,
  cfg: PluginConfig,
  recallCache: RecallCache<SearchResult>,
) {
  return async function memoryPromptSection(args: {
    userId: string;
    messages: MemoryMessage[];
  }) {
    const queryText = args.messages.at(-1)?.content ?? "";
    if (!queryText) {
      return {
        id: "libravdb-memory",
        content: "",
        };
    }

    const rpc = await getRpc();
    const [userHits, globalHits] = await Promise.all([
      rpc.call<{ results: SearchResult[] }>("search_text", {
        collection: `user:${args.userId}`,
        text: queryText,
        k: Math.ceil((cfg.topK ?? 8) / 2),
      }).catch(() => ({ results: [] })),
      rpc.call<{ results: SearchResult[] }>("search_text", {
        collection: "global",
        text: queryText,
        k: Math.ceil((cfg.topK ?? 8) / 4),
      }).catch(() => ({ results: [] })),
    ]);

    recallCache.put({
      userId: args.userId,
      queryText,
      userHits: userHits.results,
      globalHits: globalHits.results,
    });

    const ranked = scoreCandidates(
      [
        ...userHits.results,
        ...globalHits.results,
      ],
      {
        alpha: cfg.alpha,
        beta: cfg.beta,
        gamma: cfg.gamma,
        recencyLambdaSession: cfg.recencyLambdaSession,
        recencyLambdaUser: cfg.recencyLambdaUser,
        recencyLambdaGlobal: cfg.recencyLambdaGlobal,
        sessionId: "",
        userId: args.userId,
      },
    );

    const selected = fitPromptBudget(ranked, 800);
    const body = buildMemoryHeader(selected);

    return {
      id: "libravdb-memory",
      content: body,
    };
  };
}
