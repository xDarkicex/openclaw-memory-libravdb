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
  corpus?: "all" | "memory" | "sessions";
  userId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  kind?: string;
  signals?: string[];
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
            corpus: opts.corpus,
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
      const searchCorpus = normalizeSearchCorpus(params.corpus);
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

      const result = dreamQuery.active && cfg.crossSessionRecall !== false && searchCorpus !== "sessions"
        ? await client.searchText({
            collection: resolveDreamCollection(userId),
            text: queryText,
            k,
          })
        : await searchResolvedCollections(client, cfg, userId, sessionId, queryText, k, searchCorpus, params.kind, params.signals);
      const filteredResults =
        minScore === undefined
          ? result.results
          : result.results.filter((item) => item.score >= minScore);

      const legacyResults = filteredResults.map((item) => {
        const meta = parseMetadataJson(item);
        const text = resolveSearchResultText(item, meta);
        const kind = typeof meta.memory_kind === "string" ? meta.memory_kind : undefined;
        const signals = meta.memory_signals as string[] | undefined;
        const causedBy = stringArrayFromMeta(meta, "why_ids");
        const leadsTo = stringArrayFromMeta(meta, "how_ids");
        const timestamp = metaTimestamp(meta);
        const enriched: Record<string, unknown> = {
          ...item,
          text,
          content: text,
        };
        if (kind) enriched.kind = kind;
        if (signals && signals.length > 0) enriched.signals = signals;
        if (causedBy && causedBy.length > 0) enriched.caused_by = causedBy;
        if (leadsTo && leadsTo.length > 0) enriched.leads_to = leadsTo;
        if (timestamp) enriched.timestamp = timestamp;
        return enriched;
      });
      if (legacyCall) {
        return { results: legacyResults };
      }
      const memoryResults = filteredResults.map((item) => {
        const meta = parseMetadataJson(item);
        const collection = typeof meta.collection === "string" ? meta.collection : "memory";
        const relPath = encodeSearchResultPath(collection, item.id);
        const text = resolveSearchResultText(item, meta);
        returnedSearchPaths.set(relPath, text);
        return toMemorySearchResult(item, meta, text);
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
  corpus: "all" | "memory" | "sessions",
  kind?: string,
  signals?: string[],
): Promise<{ results: ProtoSearchResult[] }> {
  const collections = resolveSearchCollections(cfg, userId, sessionId, corpus);
  if (collections.length === 0) {
    return { results: [] };
  }
  const kindFilter = kind || undefined;
  const signalFilter = (signals && signals.length > 0) ? signals : undefined;
  return collections.length === 1
    ? await client.searchText({
        collection: collections[0],
        text: queryText,
        k,
        kind: kindFilter,
        signals: signalFilter,
      })
    : await client.searchTextCollections({
        collections,
        text: queryText,
        k,
        excludeByCollection: {},
        kind: kindFilter,
        signals: signalFilter,
      });
}

function resolveSearchCollections(
  cfg: PluginConfig,
  userId: string,
  sessionId: string | undefined,
  corpus: "all" | "memory" | "sessions",
): string[] {
  if (corpus === "sessions") {
    return sessionId ? [resolveSessionSearchCollection(cfg, sessionId)] : [];
  }

  const durableCollections = [resolveUserCollection(userId), "global"];
  if (corpus === "memory") {
    return durableCollections;
  }

  if (cfg.crossSessionRecall === false) {
    return sessionId ? [resolveSessionSearchCollection(cfg, sessionId)] : [];
  }

  if (!sessionId) {
    return durableCollections;
  }

  return [resolveSessionSearchCollection(cfg, sessionId), ...durableCollections];
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

function normalizeSearchCorpus(value: unknown): "all" | "memory" | "sessions" {
  return value === "memory" || value === "sessions" ? value : "all";
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

function resolveSearchResultText(
  item: ProtoSearchResult,
  meta: Record<string, unknown> = parseMetadataJson(item),
): string {
  if (typeof item.text === "string" && item.text.length > 0) {
    return item.text;
  }
  return typeof meta.text === "string" ? meta.text : item.text;
}

function toMemorySearchResult(
  item: ProtoSearchResult,
  meta: Record<string, unknown> = parseMetadataJson(item),
  text = resolveSearchResultText(item, meta),
) {
  const collection = typeof meta.collection === "string" ? meta.collection : "memory";
  const kind = typeof meta.memory_kind === "string" ? meta.memory_kind : undefined;
  const signals = meta.memory_signals as string[] | undefined;
  const causedBy = stringArrayFromMeta(meta, "why_ids");
  const leadsTo = stringArrayFromMeta(meta, "how_ids");
  const timestamp = metaTimestamp(meta);
  const result: Record<string, unknown> = {
    path: encodeSearchResultPath(collection, item.id),
    startLine: 1,
    endLine: Math.max(1, text.split("\n").length),
    score: item.score,
    snippet: text,
    source: collection.startsWith("session:") || collection.startsWith("session_") ? "sessions" : "memory",
    citation: `${collection}:${item.id}`,
  };
  if (kind) result.kind = kind;
  if (signals && signals.length > 0) result.signals = signals;
  if (causedBy && causedBy.length > 0) result.caused_by = causedBy;
  if (leadsTo && leadsTo.length > 0) result.leads_to = leadsTo;
  if (timestamp) result.timestamp = timestamp;
  return result;
}

function stringArrayFromMeta(meta: Record<string, unknown>, key: string): string[] | undefined {
  const raw = meta[key];
  if (Array.isArray(raw)) {
    const filtered = raw.filter((v): v is string => typeof v === "string");
    return filtered.length > 0 ? filtered : undefined;
  }
  return undefined;
}

function toSafeISOString(ms: number): string | undefined {
  try {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return undefined;
    return d.toISOString();
  } catch {
    return undefined;
  }
}

function metaTimestamp(meta: Record<string, unknown>): string | undefined {
  const ts = meta.ts ?? meta.created_at ?? meta.ingested_at ?? meta.timestamp;
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
    return toSafeISOString(ts);
  }
  if (typeof ts === "string" && ts.length > 0) {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) return toSafeISOString(parsed);
  }
  return undefined;
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
