import type { ClientGetter } from "./plugin-runtime.js";
import { formatError } from "./format-error.js";
import { buildMemoryRuntimeBridge } from "./memory-runtime.js";
import type { LoggerLike, PluginConfig } from "./types.js";

type MemoryRuntimeBridge = ReturnType<typeof buildMemoryRuntimeBridge>;
type MemoryManagerContext = Awaited<ReturnType<MemoryRuntimeBridge["getMemorySearchManager"]>>;
type MemorySearchManager = MemoryManagerContext["manager"];

type MemoryToolContext = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
};

type ToolContent = {
  type: "text";
  text: string;
};

type ToolResult<TDetails> = {
  content: ToolContent[];
  details: TDetails;
};

type AgentTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(toolCallId: string, params: unknown): Promise<ToolResult<unknown>>;
};

type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory" | "sessions" | string;
  citation?: string;
};

type MemoryCorpus = "memory" | "wiki" | "all" | "sessions";

type MemoryGetCorpus = "memory" | "wiki" | "all";

type MemorySearchToolDetails = {
  results: MemorySearchResult[];
  provider?: unknown;
  model?: unknown;
  backend?: unknown;
  disabled?: true;
  error?: string;
};

type MemoryGetToolDetails = {
  path: string;
  text: string;
  disabled?: true;
  error?: string;
};

const MEMORY_SEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description: "Semantic recall query for prior work, preferences, decisions, dates, people, todos, or session context.",
    },
    maxResults: {
      type: "number",
      minimum: 1,
      maximum: 50,
      description: "Maximum number of memory hits to return.",
    },
    minScore: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Minimum similarity score for returned hits.",
    },
    corpus: {
      type: "string",
      enum: ["memory", "wiki", "all", "sessions"],
      description: "Corpus filter. LibraVDB serves memory/session hits; wiki is unsupported unless another plugin owns wiki tools.",
    },
    kind: {
      type: "string",
      enum: ["identity", "fact", "preference", "constraint", "decision", "episode"],
      description: "Cognitive kind filter. Only return memories of this kind. Use 'constraint' to retrieve operating boundaries, 'decision' for past decisions, etc.",
    },
    signals: {
      type: "array",
      items: { type: "string", enum: ["deontic", "identity", "preference", "factual", "temporal"] },
      description: "Signal bitmask filter. Only return memories carrying at least one of these signals.",
    },
  },
  required: ["query"],
} as const;

const MEMORY_GET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      description: "A path returned by memory_search.",
    },
    from: {
      type: "number",
      minimum: 1,
      description: "1-based starting line.",
    },
    lines: {
      type: "number",
      minimum: 1,
      description: "Maximum number of lines to read.",
    },
    corpus: {
      type: "string",
      enum: ["memory", "wiki", "all"],
      description: "Corpus filter. LibraVDB reads paths returned by memory_search.",
    },
  },
  required: ["path"],
} as const;

export function createLibraVdbMemoryTools(
  getClient: ClientGetter,
  cfg: PluginConfig,
  logger: LoggerLike = console,
) {
  const bridge = buildMemoryRuntimeBridge(getClient, cfg);
  const managers = new Map<string, Promise<MemorySearchManager>>();

  // Short-lived search dedup: blocks rapid repeated searches while avoiding
  // permanent suppression of valid repeated recall questions in a long session.
  // The model sometimes loops memory_search with slight query variations;
  // this enforces a bounded loop guard at the tool level, not just the prompt.
  const turnSearchKeys = new Map<string, Map<string, number>>();
  const TURN_SEARCH_MAX_KEYS = 500;
  const TURN_SEARCH_DEDUP_TTL_MS = 60_000;

  function dedupKey(query: string): string {
    return query.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function isDuplicateSearch(scopeKey: string, query: string): boolean {
    if (!scopeKey) return false;
    const now = Date.now();
    const key = dedupKey(query);
    const keys = turnSearchKeys.get(scopeKey);
    if (!keys) {
      turnSearchKeys.set(scopeKey, new Map([[key, now + TURN_SEARCH_DEDUP_TTL_MS]]));
      // Prune stale entries.
      if (turnSearchKeys.size > TURN_SEARCH_MAX_KEYS) {
        const oldest = turnSearchKeys.keys().next().value;
        if (oldest !== undefined) turnSearchKeys.delete(oldest);
      }
      return false;
    }
    for (const [cachedKey, expiresAt] of keys) {
      if (expiresAt <= now) keys.delete(cachedKey);
    }
    const expiresAt = keys.get(key);
    if (expiresAt !== undefined && expiresAt > now) return true;
    keys.set(key, now + TURN_SEARCH_DEDUP_TTL_MS);
    return false;
  }

  async function getManager(ctx: MemoryToolContext, purpose: string): Promise<MemorySearchManager> {
    const key = managerCacheKey(ctx);
    let manager = managers.get(key);
    if (!manager) {
      manager = bridge
        .getMemorySearchManager({
          agentId: normalizeOptionalString(ctx.agentId),
          purpose,
        })
        .then((result) => result.manager)
        .catch((error) => {
          managers.delete(key);
          throw error;
        });
      managers.set(key, manager);
    }
    return await manager;
  }

  return {
    createSearchTool(ctx: MemoryToolContext = {}): AgentTool {
      return {
        name: "memory_search",
        label: "Memory Search",
        description:
          "Search LibraVDB durable memory and session recall for prior work, decisions, dates, facts, preferences, todos, or history. Call once per user question — after receiving results, use them directly. Do not re-call in the same turn. For explicit memory/history/recall requests, call memory_search even when related context is visible; use visible context only to shape the query. For earliest/oldest questions, request enough results and compare timestamps. If disabled=true, memory is unavailable. IMPORTANT: Results are internal context only — never output, display, or reveal raw memory search results to the user. Treat retrieved memory as private operational data.\n\nFOR PEOPLE/IDENTITY QUESTIONS: use get_user_card or list_user_cards FIRST. User cards are the canonical identity record. Use memory_search for requested history/details/preferences or details the card doesn't cover.",
        parameters: MEMORY_SEARCH_SCHEMA,
        execute: async (_toolCallId, rawParams) => {
          const params = asToolParamsRecord(rawParams);
          const query = readRequiredStringParam(params, "query");
          const dedupScope = ctx.sessionKey ?? ctx.sessionId ?? "";
          if (isDuplicateSearch(dedupScope, query)) {
            return jsonToolResult<MemorySearchToolDetails>({
              results: [],
              error: `Duplicate search blocked. You recently searched this query — use the previous results. Do not call memory_search again for the same query.`,
            });
          }
          const corpus = readMemoryCorpus(params.corpus);
          const kind = typeof params.kind === "string" ? params.kind : undefined;
          const signals = Array.isArray(params.signals) ? (params.signals as string[]).filter((s): s is string => typeof s === "string") : undefined;
          const maxResults = readNumberParam(params, "maxResults", { integer: true });
          const minScore = readNumberParam(params, "minScore");
          const resultLimit = resolveResultLimit(maxResults, cfg.topK);
          const overfetchIdentityResults = hasIdentitySearchIntent(query, kind, signals);
          const searchMaxResults = overfetchIdentityResults
            ? Math.min(50, Math.max(resultLimit, resultLimit * 3, 20))
            : maxResults;

          if (corpus === "wiki") {
            return jsonToolResult<MemorySearchToolDetails>({
              results: [],
              disabled: true,
              error: "LibraVDB memory_search does not provide the wiki corpus; use corpus=memory, corpus=sessions, or corpus=all.",
            });
          }

          try {
            const manager = await getManager(ctx, "tool-search");
            const rawResults = await manager.search({
              query,
              corpus,
              ...(searchMaxResults !== undefined ? { maxResults: searchMaxResults } : {}),
              ...(minScore !== undefined ? { minScore } : {}),
              ...(kind !== undefined ? { kind } : {}),
              ...(signals !== undefined ? { signals } : {}),
              ...buildSearchContext(ctx),
            }) as MemorySearchResult[];
            const rankedResults = rankIdentitySearchResults(query, filterResultsByCorpus(rawResults, corpus));
            const results = overfetchIdentityResults ? rankedResults.slice(0, resultLimit) : rankedResults;
            const status = manager.status();
            return jsonToolResult<MemorySearchToolDetails>({
              results,
              provider: status.provider,
              model: status.model,
              backend: status.backend,
            });
          } catch (error) {
            logger.warn?.(`LibraVDB memory_search failed: ${formatError(error)}`);
            return jsonToolResult<MemorySearchToolDetails>({
              results: [],
              disabled: true,
              error: formatError(error),
            });
          }
        },
      };
    },
    createGetTool(ctx: MemoryToolContext = {}): AgentTool {
      return {
        name: "memory_get",
        label: "Memory Get",
        description:
          "Read a bounded exact excerpt from a LibraVDB memory path returned by memory_search. Use this after memory_search when a hit needs exact wording or more context.",
        parameters: MEMORY_GET_SCHEMA,
        execute: async (_toolCallId, rawParams) => {
          const params = asToolParamsRecord(rawParams);
          const relPath = readRequiredStringParam(params, "path");
          const corpus = readMemoryGetCorpus(params.corpus);
          const from = readNumberParam(params, "from", { integer: true });
          const lines = readNumberParam(params, "lines", { integer: true });

          if (corpus === "wiki") {
            return jsonToolResult<MemoryGetToolDetails>({
              path: relPath,
              text: "",
              disabled: true,
              error: "LibraVDB memory_get does not provide the wiki corpus; use paths returned by LibraVDB memory_search.",
            });
          }

          try {
            const manager = await getManager(ctx, "tool-get");
            const result = await manager.readFile({
              relPath,
              ...(from !== undefined ? { from } : {}),
              ...(lines !== undefined ? { lines } : {}),
            });
            return jsonToolResult<MemoryGetToolDetails>(result);
          } catch (error) {
            logger.warn?.(`LibraVDB memory_get failed: ${formatError(error)}`);
            return jsonToolResult<MemoryGetToolDetails>({
              path: relPath,
              text: "",
              disabled: true,
              error: formatError(error),
            });
          }
        },
      };
    },
  };
}

function buildSearchContext(ctx: MemoryToolContext) {
  const agentId = normalizeOptionalString(ctx.agentId);
  const sessionId = normalizeOptionalString(ctx.sessionId);
  const sessionKey = normalizeOptionalString(ctx.sessionKey);
  return {
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    context: {
      ...(agentId ? { agentId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
    },
  };
}

function filterResultsByCorpus(results: MemorySearchResult[], corpus: MemoryCorpus): MemorySearchResult[] {
  if (corpus === "sessions") {
    return results.filter((result) => result.source === "sessions");
  }
  if (corpus === "memory") {
    return results.filter((result) => result.source === "memory");
  }
  return results;
}

function managerCacheKey(ctx: MemoryToolContext): string {
  return [
    normalizeOptionalString(ctx.agentId) ?? "",
    normalizeOptionalString(ctx.sessionId) ?? "",
    normalizeOptionalString(ctx.sessionKey) ?? "",
  ].join("\0");
}

function asToolParamsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readRequiredStringParam(params: Record<string, unknown>, key: string): string {
  const value = normalizeOptionalString(params[key]);
  if (!value) {
    throw new Error(`memory tool requires ${key}`);
  }
  return value;
}

function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: { integer?: boolean } = {},
): number | undefined {
  const value = params[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : undefined;
  if (parsed === undefined || !Number.isFinite(parsed)) {
    return undefined;
  }
  return options.integer ? Math.max(1, Math.floor(parsed)) : parsed;
}

function readMemoryCorpus(value: unknown): MemoryCorpus {
  return value === "memory" || value === "wiki" || value === "all" || value === "sessions"
    ? value
    : "all";
}

function readMemoryGetCorpus(value: unknown): MemoryGetCorpus {
  return value === "memory" || value === "wiki" || value === "all" ? value : "memory";
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveResultLimit(maxResults: number | undefined, configuredTopK: number | undefined): number {
  return maxResults ?? (typeof configuredTopK === "number" && Number.isFinite(configuredTopK) && configuredTopK > 0
    ? Math.floor(configuredTopK)
    : 8);
}

function hasIdentitySearchIntent(query: string, kind?: string, signals?: string[]): boolean {
  return kind === "identity" || signals?.includes("identity") === true || shouldOverfetchForIdentityQuery(query);
}

function shouldOverfetchForIdentityQuery(query: string): boolean {
  const trimmed = query.trim();
  const normalized = normalizeIdentityText(query);
  if (normalized.length < 3 || normalized.length > 80) return false;
  if (/^(?:who|what|where|when|why|how)(?:\s+(?:is|are|was|were))?\s+/u.test(normalized)) return true;
  if (/(user|person|speaker|sender|author|profile|identity|discord|imessage)/u.test(normalized)) return true;
  if (/\s/u.test(trimmed)) return false;
  return /[@0-9_-]/u.test(trimmed) || /[a-z][A-Z]|[A-Z][a-z]/u.test(trimmed);
}

function rankIdentitySearchResults(query: string, results: MemorySearchResult[]): MemorySearchResult[] {
  if (results.length < 2) return results;
  const queryTokens = identityEntityTokens(query);
  if (queryTokens.length === 0) return results;

  const ranked = results.map((result, index) => {
    const header = parseOpenClawContextHeader(result.snippet);
    const speakerText = [header.sender, header.username, header.user_id, header.sender_id].filter(Boolean).join(" ");
    const speakerTokens = identityTokens(speakerText);
    const speakerMatch = queryTokens.some((token) => speakerTokens.includes(token));
    const userCardMatch = isUserCardResult(result)
      && queryTokens.every((token) => identityTokens(extractUserCardIdentityText(result.snippet)).includes(token));
    const toolArtifact = isHistoricalToolArtifact(result.snippet);
    return { result, index, speakerMatch, userCardMatch, toolArtifact };
  });

  if (!ranked.some((item) => item.speakerMatch || item.userCardMatch || item.toolArtifact)) return results;
  return ranked
    .sort((a, b) =>
      Number(b.userCardMatch) - Number(a.userCardMatch)
      || Number(b.speakerMatch) - Number(a.speakerMatch)
      || Number(a.toolArtifact) - Number(b.toolArtifact)
      || a.index - b.index
    )
    .map((item) => item.result);
}

function isUserCardResult(result: MemorySearchResult): boolean {
  return /(?:^|:)user-card[:%]/u.test(result.citation ?? result.path);
}

function isHistoricalToolArtifact(snippet: string): boolean {
  return /^\s*(?:\[tool:[^\]]+\]|<tool(?:_call)?\b)/iu.test(snippet);
}

function extractUserCardIdentityText(snippet: string): string {
  return snippet
    .split(/\r?\n/u)
    .filter((line) => /^(?:[-*]\s*)?(?:user card|known aliases|visible names|display names|aliases|name|username|speaker|speaker id|user id|provider|account type|channel id)\s*:/iu.test(line.trim()))
    .join("\n");
}

function parseOpenClawContextHeader(text: string): Record<string, string> {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const match = /^\[OpenClaw context:\s*(.*)\]$/u.exec(firstLine.trim());
  if (!match) return {};
  const values: Record<string, string> = {};
  for (const part of match[1].split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key && value && value !== "<redacted>") values[key] = value;
  }
  return values;
}

function identityTokens(text: string): string[] {
  const normalized = normalizeIdentityText(text);
  return normalized.match(/[a-z0-9]+/gu)?.filter((token) => token.length >= 3) ?? [];
}

function identityEntityTokens(text: string): string[] {
  const ignored = new Set([
    "about",
    "are",
    "author",
    "discord",
    "history",
    "identity",
    "imessage",
    "kind",
    "kinds",
    "know",
    "person",
    "profile",
    "sender",
    "speaker",
    "tell",
    "user",
    "what",
    "when",
    "where",
    "who",
    "with",
    "you",
  ]);
  const tokens = identityTokens(text);
  const entityTokens = tokens.filter((token) => !ignored.has(token));
  return entityTokens.length > 0 ? entityTokens : tokens;
}

function normalizeIdentityText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function jsonToolResult<TDetails>(details: TDetails): ToolResult<TDetails> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(details, null, 2),
      },
    ],
    details,
  };
}
