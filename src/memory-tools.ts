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
          "Mandatory fresh LibraVDB recall step: semantically search durable memory and session recall before answering questions about prior work, decisions, dates, people, preferences, todos, or history. Do not reuse prior transcript claims or older memory_search results for a new memory lookup. For earliest/oldest questions, request enough results and compare timestamps in snippets. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
        parameters: MEMORY_SEARCH_SCHEMA,
        execute: async (_toolCallId, rawParams) => {
          const params = asToolParamsRecord(rawParams);
          const query = readRequiredStringParam(params, "query");
          const corpus = readMemoryCorpus(params.corpus);
          const maxResults = readNumberParam(params, "maxResults", { integer: true });
          const minScore = readNumberParam(params, "minScore");

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
              ...(maxResults !== undefined ? { maxResults } : {}),
              ...(minScore !== undefined ? { minScore } : {}),
              ...buildSearchContext(ctx),
            }) as MemorySearchResult[];
            const results = filterResultsByCorpus(rawResults, corpus);
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
