import type { RpcGetter } from "./plugin-runtime.js";
import { resolveDurableNamespace } from "./durable-namespace.js";
import { detectDreamQuerySignal, resolveDreamCollection } from "./dream-routing.js";
import type { PluginConfig, SearchResult } from "./types.js";

type RpcLike = {
  call<T>(method: string, params: unknown): Promise<T>;
};

type MemorySearchParams = {
  query?: string;
  text?: string;
  input?: string;
  q?: string;
  k?: number;
  limit?: number;
  topK?: number;
  userId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  context?: {
    userId?: string;
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
  };
};

type MemoryRuntimeStatus = {
  ok?: boolean;
  message?: string;
  turnCount?: number;
  memoryCount?: number;
  gatingThreshold?: number;
  abstractiveReady?: boolean;
  embeddingProfile?: string;
};

export function buildMemoryRuntimeBridge(getRpc: RpcGetter, cfg: PluginConfig) {
  return {
    async getMemorySearchManager(params: { agentId?: string; purpose?: string } = {}) {
      const status = await readStatus(getRpc, params.purpose);
      return {
        manager: createMemorySearchManager(getRpc, cfg, params, status),
      };
    },
    resolveMemoryBackendConfig() {
      // We keep retrieval inside the plugin-side sidecar rather than delegating to
      // OpenClaw's external QMD path.
      return { backend: "builtin" };
    },
    async closeAllMemorySearchManagers() {
      // Context-engine lifecycle cleanup still happens through gateway_stop.
    },
  };
}

function createMemorySearchManager(
  getRpc: RpcGetter,
  cfg: PluginConfig,
  defaults: { agentId?: string; purpose?: string },
  initialStatus: MemoryRuntimeStatus & Record<string, unknown>,
) {
  let cachedStatus = initialStatus;

  return {
    async search(queryOrParams: string | MemorySearchParams = {}, opts: MemorySearchParams = {}) {
      const legacyCall = typeof queryOrParams === "string";
      const params = legacyCall
        ? {
            query: queryOrParams,
            limit: opts.limit ?? opts.k ?? opts.topK,
            sessionId: opts.sessionId,
            sessionKey: opts.sessionKey,
            userId: opts.userId,
            agentId: opts.agentId,
            context: opts.context,
          }
        : queryOrParams;
      const queryText = firstString(params.query, params.text, params.input, params.q);
      if (!queryText) {
        return legacyCall ? { results: [], error: "Missing query text for LibraVDB memory search" } : [];
      }

      const dreamQuery = detectDreamQuerySignal(queryText);
      const sessionId = firstString(params.sessionId, params.context?.sessionId);
      const userId = resolveDurableNamespace({
        userId: firstString(params.userId, params.context?.userId),
        sessionKey: firstString(params.sessionKey, params.context?.sessionKey),
        agentId: firstString(params.agentId, params.context?.agentId, defaults.agentId),
        fallback: sessionId ? `session:${sessionId}` : undefined,
      });
      const k = normalizePositiveInteger(params.k, params.limit, params.topK, cfg.topK, 8);
      const rpc = await getRpc();

      const result = dreamQuery.active
        ? await rpc.call<{ results: SearchResult[] }>("search_text", {
            collection: resolveDreamCollection(userId),
            text: queryText,
            k,
          })
        : await searchResolvedCollections(rpc, cfg, userId, sessionId, queryText, k);

      const legacyResults = result.results.map((item) => ({
        ...item,
        content: item.text,
      }));
      if (legacyCall) {
        return { results: legacyResults };
      }
      return result.results.map(toMemorySearchResult);
    },
    async readFile(params: { relPath: string; from?: number; lines?: number }) {
      const located = await loadSearchResultText(getRpc, params.relPath);
      const fromLine = Math.max(1, params.from ?? 1);
      const lineCount = Math.max(1, params.lines ?? 200);
      const lines = located.text.split("\n");
      const text = lines.slice(fromLine - 1, fromLine - 1 + lineCount).join("\n");
      return {
        text,
        path: located.path,
      };
    },
    async ingest() {
      // The plugin already owns per-turn ingest through the context engine.
      return { ingested: false, delegatedToContextEngine: true };
    },
    async sync() {
      cachedStatus = await readStatus(getRpc, defaults.purpose);
      return { synced: true, delegatedToContextEngine: true };
    },
    status() {
      return cachedStatus;
    },
    async probeEmbeddingAvailability() {
      return {
        ok: cachedStatus.ok ?? false,
        ...(cachedStatus.ok === false && typeof cachedStatus.message === "string"
          ? { error: cachedStatus.message }
          : {}),
      };
    },
    async probeVectorAvailability() {
      return cachedStatus.ok ?? false;
    },
    async close() {
      // The sidecar connection is shared by the plugin runtime.
    },
  };
}

async function searchResolvedCollections(
  rpc: RpcLike,
  cfg: PluginConfig,
  userId: string,
  sessionId: string | undefined,
  queryText: string,
  k: number,
): Promise<{ results: SearchResult[] }> {
  const collections = resolveSearchCollections(cfg, userId, sessionId);
  return collections.length === 1
    ? await rpc.call<{ results: SearchResult[] }>("search_text", {
        collection: collections[0],
        text: queryText,
        k,
      })
    : await rpc.call<{ results: SearchResult[] }>("search_text_collections", {
        collections,
        text: queryText,
        k,
        excludeByCollection: {},
      });
}

function resolveSearchCollections(cfg: PluginConfig, userId: string, sessionId?: string): string[] {
  const collections = [`user:${userId}`, "global"];
  if (!sessionId) {
    return collections;
  }

  if (cfg.useSessionSummarySearchExperiment) {
    collections.unshift(`session_summary:${sessionId}`);
    return collections;
  }
  if (cfg.useSessionRecallProjection) {
    collections.unshift(`session_recall:${sessionId}`);
    return collections;
  }
  collections.unshift(`session:${sessionId}`);
  return collections;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function toMemorySearchResult(item: SearchResult) {
  const collection = typeof item.metadata.collection === "string" ? item.metadata.collection : "memory";
  return {
    path: encodeSearchResultPath(collection, item.id),
    startLine: 1,
    endLine: Math.max(1, item.text.split("\n").length),
    score: item.score,
    snippet: item.text,
    source: collection.startsWith("session:") || collection.startsWith("session_") ? "sessions" : "memory",
    citation: `${collection}:${item.id}`,
  };
}

async function loadSearchResultText(getRpc: RpcGetter, relPath: string): Promise<{ path: string; text: string }> {
  const { collection, id } = decodeSearchResultPath(relPath);
  const rpc = await getRpc();
  const result = await rpc.call<{ results: SearchResult[] }>("list_collection", { collection });
  const item = result.results.find((entry) => entry.id === id);
  if (!item) {
    throw new Error(`LibraVDB memory path not found: ${relPath}`);
  }
  return {
    path: relPath,
    text: item.text,
  };
}

function encodeSearchResultPath(collection: string, id: string): string {
  return `${encodeURIComponent(collection)}::${encodeURIComponent(id)}`;
}

function decodeSearchResultPath(relPath: string): { collection: string; id: string } {
  const separator = relPath.indexOf("::");
  if (separator <= 0) {
    throw new Error(`Unsupported LibraVDB memory path: ${relPath}`);
  }
  return {
    collection: decodeURIComponent(relPath.slice(0, separator)),
    id: decodeURIComponent(relPath.slice(separator + 2)),
  };
}

async function readStatus(
  getRpc: RpcGetter,
  purpose: string | undefined,
): Promise<MemoryRuntimeStatus & Record<string, unknown>> {
  try {
    const rpc = await getRpc();
    const status = await rpc.call<MemoryRuntimeStatus & Record<string, unknown>>("status", {});
    return {
      ...status,
      backend: "builtin",
      provider: "libravdb",
      model: status.embeddingProfile ?? "unknown",
      ok: status.ok ?? false,
      message: status.message ?? "ok",
      turnCount: status.turnCount ?? 0,
      memoryCount: status.memoryCount ?? 0,
      gatingThreshold: status.gatingThreshold,
      abstractiveReady: status.abstractiveReady ?? false,
      embeddingProfile: status.embeddingProfile ?? "unknown",
      purpose,
    };
  } catch (error) {
    return {
      backend: "builtin",
      provider: "libravdb",
      model: "unknown",
      ok: false,
      message: error instanceof Error && error.message ? error.message : String(error),
      turnCount: 0,
      memoryCount: 0,
      embeddingProfile: "unknown",
      purpose,
    };
  }
}

function normalizePositiveInteger(...values: Array<number | undefined>): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.max(1, Math.floor(value));
    }
  }
  return 8;
}
