import type { ClientGetter } from "./plugin-runtime.js";
import type { LibravDBClient } from "./libravdb-client.js";
import { resolveDurableNamespace, resolveUserCollection } from "./memory-scopes.js";
import { resolveIdentity } from "./identity.js";
import { detectDreamQuerySignal, resolveDreamCollection } from "./dream-routing.js";
import type { PluginConfig, LoggerLike } from "./types.js";
import type { SearchResult as ProtoSearchResult } from "@xdarkicex/libravdb-contracts";

type MemorySearchParams = {
  query?: string;
  text?: string;
  input?: string;
  q?: string;
  k?: number;
  limit?: number;
  maxResults?: number;
  minScore?: number;
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

export function buildMemoryRuntimeBridge(getClient: ClientGetter, cfg: PluginConfig) {
  return {
    async getMemorySearchManager(params: { agentId?: string; purpose?: string } = {}) {
      const status = await readStatus(getClient, params.purpose);
      return {
        manager: createMemorySearchManager(getClient, cfg, params, status),
      };
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" };
    },
    async closeAllMemorySearchManagers() {
      // Context-engine lifecycle cleanup still happens through gateway_stop.
    },
  };
}

function createMemorySearchManager(
  getClient: ClientGetter,
  cfg: PluginConfig,
  defaults: { agentId?: string; purpose?: string },
  initialStatus: MemoryRuntimeStatus & Record<string, unknown>,
) {
  let cachedStatus = initialStatus;
  let cachedIdentityUserId: string | null = null;
  const returnedSearchPaths = new Map<string, string>();

  function getResolvedUserId(sessionKey: string | undefined): string {
    if (cachedIdentityUserId !== null) return cachedIdentityUserId;
    cachedIdentityUserId = resolveIdentity({
      configUserId: cfg.userId,
      identityPath: cfg.identityPath,
      sessionKey,
    }).userId;
    return cachedIdentityUserId;
  }

  return {
    async search(queryOrParams: string | MemorySearchParams = {}, opts: MemorySearchParams = {}) {
      const legacyCall = typeof queryOrParams === "string";
      const params = legacyCall
        ? {
            query: queryOrParams,
            limit: opts.limit ?? opts.k ?? opts.maxResults ?? opts.topK,
            minScore: opts.minScore,
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
      const explicitUserId = firstString(params.userId, params.context?.userId);
      const resolvedUserId =
        explicitUserId ??
        getResolvedUserId(firstString(params.sessionKey, params.context?.sessionKey));
      const userId = resolveDurableNamespace({
        userId: resolvedUserId,
        sessionKey: firstString(params.sessionKey, params.context?.sessionKey),
        agentId: firstString(params.agentId, params.context?.agentId, defaults.agentId),
        fallback: sessionId ? `session:${sessionId}` : undefined,
      });
      const k = normalizePositiveInteger(params.k, params.limit, params.maxResults, params.topK, cfg.topK, 8);
      const minScore = normalizeNumber(params.minScore);
      const client = await getClient();

      const result = dreamQuery.active && cfg.crossSessionRecall !== false
        ? await client.searchText({
            collection: resolveDreamCollection(userId),
            text: queryText,
            k,
          })
        : await searchResolvedCollections(client, cfg, userId, sessionId, queryText, k);
      const filteredResults =
        minScore === undefined
          ? result.results
          : result.results.filter((item) => item.score >= minScore);

      const legacyResults = filteredResults.map((item) => ({
        ...item,
        content: item.text,
      }));
      if (legacyCall) {
        return { results: legacyResults };
      }
      const memoryResults = filteredResults.map((item) => {
        const meta = parseMetadataJson(item);
        const collection = typeof meta.collection === "string" ? meta.collection : "memory";
        const relPath = encodeSearchResultPath(collection, item.id);
        returnedSearchPaths.set(relPath, item.text);
        return toMemorySearchResult(item);
      });
      return memoryResults;
    },
    async readFile(params: { relPath: string; from?: number; lines?: number }) {
      const cachedText = returnedSearchPaths.get(params.relPath);
      if (cachedText === undefined) {
        throw new Error("LibraVDB memory path was not returned by this search manager");
      }
      const fromLine = Math.max(1, params.from ?? 1);
      const lineCount = Math.max(1, params.lines ?? 200);
      const lines = cachedText.split("\n");
      const text = lines.slice(fromLine - 1, fromLine - 1 + lineCount).join("\n");
      return {
        text,
        path: params.relPath,
      };
    },
    async ingest() {
      return { ingested: false, delegatedToContextEngine: true };
    },
    async sync(_params?: { reason?: string; force?: boolean }) {
      cachedStatus = await readStatus(getClient, defaults.purpose);
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
      // The client connection is shared by the plugin runtime.
    },
  };
}

async function searchResolvedCollections(
  client: LibravDBClient,
  cfg: PluginConfig,
  userId: string,
  sessionId: string | undefined,
  queryText: string,
  k: number,
): Promise<{ results: ProtoSearchResult[] }> {
  const collections = resolveSearchCollections(cfg, userId, sessionId);
  if (collections.length === 0) {
    return { results: [] };
  }
  return collections.length === 1
    ? await client.searchText({
        collection: collections[0],
        text: queryText,
        k,
      })
    : await client.searchTextCollections({
        collections,
        text: queryText,
        k,
        excludeByCollection: {},
      });
}

function resolveSearchCollections(cfg: PluginConfig, userId: string, sessionId?: string): string[] {
  if (cfg.crossSessionRecall === false) {
    return sessionId ? [resolveSessionSearchCollection(cfg, sessionId)] : [];
  }

  const collections = [resolveUserCollection(userId), "global"];
  if (!sessionId) {
    return collections;
  }

  collections.unshift(resolveSessionSearchCollection(cfg, sessionId));
  return collections;
}

function resolveSessionSearchCollection(cfg: PluginConfig, sessionId: string): string {
  if (cfg.useSessionSummarySearchExperiment) {
    return `session_summary:${sessionId}`;
  }
  if (cfg.useSessionRecallProjection) {
    return `session_recall:${sessionId}`;
  }
  return `session:${sessionId}`;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function parseMetadataJson(item: { metadataJson?: Uint8Array }): Record<string, unknown> {
  if (item.metadataJson && item.metadataJson.length > 0) {
    try {
      return JSON.parse(new TextDecoder().decode(item.metadataJson));
    } catch (e) {
      // ignore
    }
  }
  return {};
}

function toMemorySearchResult(item: ProtoSearchResult) {
  const meta = parseMetadataJson(item);
  const collection = typeof meta.collection === "string" ? meta.collection : "memory";
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

function encodeSearchResultPath(collection: string, id: string): string {
  return `${encodeURIComponent(collection)}::${encodeURIComponent(id)}`;
}

async function readStatus(
  getClient: ClientGetter,
  purpose: string | undefined,
): Promise<MemoryRuntimeStatus & Record<string, unknown>> {
  try {
    const client = await getClient();
    const status = await client.status({});
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

function normalizeNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
