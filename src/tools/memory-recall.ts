import type { ClientGetter } from "../plugin-runtime.js";
import { formatError } from "../format-error.js";
import type { LoggerLike } from "../types.js";
import { consumeSubagentBudget } from "../context-engine.js";

// ── Tool types ──

type ToolContent = { type: "text"; text: string };
type ToolResult<T> = { content: ToolContent[]; details: T };

type MemoryDescribeDetails = {
  summaryId: string;
  found: boolean;
  evictionCue?: string;
  depth?: number;
  descendantCount?: number;
  sourceTurnCount?: number;
  sourceTurnIds?: string[];
  parentSummaryIds?: string[];
  error?: string;
};

type MemoryExpandDetails = {
  summaryId: string;
  depth: number;
  text: string;
  truncated: boolean;
  exceededBudget: boolean;
  parentCount: number;
  error?: string;
};

type MemoryGrepDetails = {
  pattern: string;
  mode: "regex" | "text";
  totalMatches: number;
  summaries: Array<{
    summaryId: string;
    snippet: string;
    score: number;
    evictionCue?: string;
  }>;
  turns: Array<{
    turnId: string;
    snippet: string;
    role: string;
    score: number;
  }>;
  truncated: boolean;
};

// ── Constants ──

const MAX_EXPAND_TOKENS = 8000;
const MAX_EXPAND_CHARS = MAX_EXPAND_TOKENS * 4;
const MAX_GREP_RESULTS = 50;
const MAX_GREP_CHARS = 40000;
const MAX_SNIPPET_CHARS = 200;

// ── Schemas ──

const MEMORY_DESCRIBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summaryId: {
      type: "string",
      description: "A summary ID (sum_xxx format) returned by memory_search. Inspect metadata without expanding.",
    },
    sessionId: {
      type: "string",
      description: "Session ID the summary belongs to. If omitted, uses the current session.",
    },
  },
  required: ["summaryId"],
} as const;

const MEMORY_EXPAND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summaryIds: {
      type: "array",
      items: { type: "string" },
      description: "Summary IDs (sum_xxx format) to expand. Use results from memory_search or memory_describe.",
    },
    maxDepth: {
      type: "number",
      minimum: 0,
      maximum: 5,
      description: "Max tree traversal depth per summary (default: 1). 0 returns only the cue/metadata.",
    },
    maxTokens: {
      type: "number",
      minimum: 100,
      maximum: Number(MAX_EXPAND_TOKENS),
      description: `Token budget cap for the expansion result (default: ${MAX_EXPAND_TOKENS}).`,
    },
    sessionId: {
      type: "string",
      description: "Session ID the summary belongs to. If omitted, uses the current session.",
    },
  },
  required: ["summaryIds"],
} as const;

const MEMORY_GREP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pattern: {
      type: "string",
      description: "Search pattern. Regex when mode=regex, plain text when mode=text.",
    },
    mode: {
      type: "string",
      enum: ["regex", "text"],
      description: 'Search mode. Default: "text".',
    },
    scope: {
      type: "string",
      enum: ["messages", "summaries", "both"],
      description: 'What to search. Default: "both".',
    },
    limit: {
      type: "number",
      minimum: 1,
      maximum: 200,
      description: `Max results (default: ${MAX_GREP_RESULTS}).`,
    },
    sessionId: {
      type: "string",
      description: "Session ID to search within. If omitted, uses the current session.",
    },
  },
  required: ["pattern"],
} as const;

// ── Helpers ──

function truncateSnippet(text: string, maxLen: number = MAX_SNIPPET_CHARS): string {
  const singleLine = text.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.slice(0, maxLen - 3) + "...";
}

function jsonResult<T>(details: T): ToolResult<T> {
  return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}

function asParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readStr(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function readNum(params: Record<string, unknown>, key: string, opts?: { integer?: boolean; min?: number }): number | undefined {
  const v = params[key];
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : undefined;
  if (n === undefined || !Number.isFinite(n)) return undefined;
  const min = opts?.min ?? 1;
  return opts?.integer ? Math.max(min, Math.floor(n)) : n;
}

function formatEvictionCueLine(cue: string | undefined, summaryId: string): string {
  if (!cue) return `[Summary ${summaryId}]`;
  const firstLine = cue.split("\n")[0] ?? "";
  return `[Summary ${summaryId}]: ${firstLine}`;
}

function safeMatch(text: string, pattern: string, mode: "regex" | "text"): boolean {
  if (mode === "text") return text.toLowerCase().includes(pattern.toLowerCase());
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
}

// ── Tool factories ──

export function createMemoryDescribeTool(
  getClient: ClientGetter,
  getSessionId: () => string | undefined = () => undefined,
  logger: LoggerLike = console,
) {
  return {
    name: "memory_describe",
    label: "Memory Describe",
    description:
      "Inspect a summary's metadata without expanding its full text. " +
      "Returns eviction cues (anchors, decisions, constraints, signal counts), " +
      "child summary count, and source turn range. Use this before memory_expand " +
      "to decide whether the summary is worth the expansion cost.",
    parameters: MEMORY_DESCRIBE_SCHEMA,
    execute: async (_toolCallId: string, rawParams: unknown): Promise<ToolResult<MemoryDescribeDetails>> => {
      const params = asParams(rawParams);
      const summaryId = readStr(params, "summaryId");
      if (!summaryId) throw new Error("memory_describe requires summaryId");

      try {
        const client = await getClient();
        const sessionId = readStr(params, "sessionId") ?? getSessionId() ?? "";

        // Use ExpandSummary with maxDepth=0 to get metadata without expanding children.
        // maxDepth=0 returns just the target summary's text + metadata_json.
        const resp = await client.expandSummary({
          sessionId,
          summaryId,
          maxDepth: 0,
        });

        let evictionCue: string | undefined;
        let meta: Record<string, unknown> = {};
        if (resp.metadataJson && resp.metadataJson.length > 0) {
          try {
            const decoder = new TextDecoder();
            meta = JSON.parse(decoder.decode(resp.metadataJson)) as Record<string, unknown>;
            evictionCue = typeof meta.eviction_cue === "string" ? meta.eviction_cue : undefined;
          } catch { /* metadata parse best-effort */ }
        }

        const lineage = (meta.continuity_lineage ?? {}) as Record<string, unknown>;
        const sourceTurnIds = Array.isArray(lineage.source_turn_ids) ? lineage.source_turn_ids as string[] : [];
        const parentSummaryIds = Array.isArray(lineage.parent_summary_ids) ? lineage.parent_summary_ids as string[] : [];

        return jsonResult<MemoryDescribeDetails>({
          summaryId,
          found: true,
          evictionCue,
          depth: typeof meta.compaction_generation === "number" ? meta.compaction_generation as number : undefined,
          descendantCount: typeof meta.descendant_count === "number" ? meta.descendant_count as number : undefined,
          sourceTurnCount: sourceTurnIds.length,
          sourceTurnIds: sourceTurnIds.slice(0, 10),
          parentSummaryIds: parentSummaryIds.slice(0, 10),
        });
      } catch (error) {
        logger.warn?.(`memory_describe failed: ${formatError(error)}`);
        return jsonResult<MemoryDescribeDetails>({
          summaryId,
          found: false,
          error: formatError(error),
        });
      }
    },
  };
}

export function createMemoryExpandTool(
  getClient: ClientGetter,
  getSessionKey: () => string | undefined,
  logger: LoggerLike = console,
) {
  return {
    name: "memory_expand",
    label: "Memory Expand",
    description:
      "Expand compacted summaries to recover full detail. Walks the summary tree " +
      "up to maxDepth levels. For large expansions (>2500 tokens), spawns a " +
      "sub-agent to protect context. Use memory_describe first to check if expansion " +
      "is warranted — many questions can be answered from the eviction cue alone.",
    parameters: MEMORY_EXPAND_SCHEMA,
    execute: async (_toolCallId: string, rawParams: unknown): Promise<ToolResult<MemoryExpandDetails>> => {
      const params = asParams(rawParams);
      const rawIds = params.summaryIds;
      const summaryIds: string[] = Array.isArray(rawIds) ? rawIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
      if (summaryIds.length === 0) throw new Error("memory_expand requires at least one summaryId");

      const maxDepth = readNum(params, "maxDepth", { integer: true, min: 0 }) ?? 1;
      let maxTokens = readNum(params, "maxTokens", { integer: true }) ?? MAX_EXPAND_TOKENS;
      const sessionId = readStr(params, "sessionId") ?? "";

      // Subagent budget gate: if this is a subagent, check remaining expansion budget.
      const sessionKey = getSessionKey();
      if (sessionKey) {
        const grantedTokens = consumeSubagentBudget(sessionKey, maxTokens);
        if (grantedTokens === 0) {
          return {
            content: [{ type: "text", text: "[Subagent expansion budget exhausted. Narrow the query or request fewer summaries.]" }],
            details: { summaryId: summaryIds[0] ?? "", depth: maxDepth, text: "", truncated: true, exceededBudget: true, parentCount: 0 },
          };
        }
        if (grantedTokens > 0 && grantedTokens < maxTokens) {
          // Clamp to remaining budget.
          logger.info?.(`subagent expansion budget clamped from ${maxTokens} to ${grantedTokens} tokens`);
          maxTokens = grantedTokens;
        }
      }

      try {
        const client = await getClient();
        const parts: string[] = [];
        let totalChars = 0;
        let truncated = false;
        let parentCount = 0;

        for (const sid of summaryIds) {
          if (totalChars >= MAX_EXPAND_CHARS) {
            truncated = true;
            break;
          }
          const resp = await client.expandSummary({
            sessionId,
            summaryId: sid,
            maxDepth,
          });

          if (resp.text) {
            // Count children from metadata if available
            let meta: Record<string, unknown> = {};
            if (resp.metadataJson && resp.metadataJson.length > 0) {
              try {
                const decoder = new TextDecoder();
                meta = JSON.parse(decoder.decode(resp.metadataJson)) as Record<string, unknown>;
              } catch { /* best-effort */ }
            }
            const lineage = (meta.continuity_lineage ?? {}) as Record<string, unknown>;
            const parents = Array.isArray(lineage.parent_summary_ids) ? (lineage.parent_summary_ids as string[]).length : 0;
            parentCount += parents;

            const remaining = MAX_EXPAND_CHARS - totalChars;
            const text = resp.text.length > remaining ? resp.text.slice(0, remaining) + "\n...[truncated]" : resp.text;
            parts.push(`## ${sid}\n${text}`);
            totalChars += text.length;
            if (resp.text.length > remaining) {
              truncated = true;
              break;
            }
          }
        }

        const text = parts.join("\n\n");
        const exceededBudget = totalChars > maxTokens * 4;

        if (exceededBudget) {
          return {
            content: [{
              type: "text",
              text: `[Expansion exceeds ${maxTokens}-token budget. Use memory_describe to navigate child summaries, or narrow with specific summaryIds.]`,
            }],
            details: { summaryId: summaryIds[0] ?? "", depth: maxDepth, text: "", truncated: true, exceededBudget: true, parentCount },
          };
        }

        return jsonResult<MemoryExpandDetails>({
          summaryId: summaryIds[0] ?? "",
          depth: maxDepth,
          text,
          truncated,
          exceededBudget,
          parentCount,
        });
      } catch (error) {
        logger.warn?.(`memory_expand failed: ${formatError(error)}`);
        return jsonResult<MemoryExpandDetails>({
          summaryId: summaryIds[0] ?? "",
          depth: maxDepth,
          text: "",
          truncated: false,
          exceededBudget: false,
          parentCount: 0,
          error: formatError(error),
        });
      }
    },
  };
}

export function createMemoryGrepTool(
  getClient: ClientGetter,
  getSessionId: () => string | undefined = () => undefined,
  logger: LoggerLike = console,
) {
  return {
    name: "memory_grep",
    label: "Memory Grep",
    description:
      "Search compacted conversation history by text or regex pattern. " +
      "Searches across session summaries and raw turns. Returns matching snippets " +
      "with summary/turn IDs for follow-up with memory_describe or memory_expand.",
    parameters: MEMORY_GREP_SCHEMA,
    execute: async (_toolCallId: string, rawParams: unknown): Promise<ToolResult<MemoryGrepDetails>> => {
      const params = asParams(rawParams);
      const pattern = readStr(params, "pattern");
      if (!pattern) throw new Error("memory_grep requires pattern");

      const mode = (params.mode === "regex" ? "regex" : "text") as "regex" | "text";
      const scope = (params.scope === "messages" ? "messages" : params.scope === "summaries" ? "summaries" : "both") as "messages" | "summaries" | "both";
      const limit = readNum(params, "limit", { integer: true }) ?? MAX_GREP_RESULTS;
      const sessionId = readStr(params, "sessionId") ?? getSessionId() ?? "";

      try {
        const client = await getClient();
        const summaries: MemoryGrepDetails["summaries"] = [];
        const turns: MemoryGrepDetails["turns"] = [];
        let totalChars = 0;
        let totalMatches = 0;

        if (scope === "summaries" || scope === "both") {
          const searchK = Math.min(limit * 3, 200);
          const summaryResults = await client.searchText({
            collection: `session_summary:${sessionId}`,
            text: pattern,
            k: searchK,
          });
          for (const r of (summaryResults.results ?? [])) {
            if (summaries.length >= limit || totalChars >= MAX_GREP_CHARS) break;
            if (!safeMatch(r.text, pattern, mode)) continue;
            totalMatches++;
            let evictionCue: string | undefined;
            if (r.metadataJson && r.metadataJson.length > 0) {
              try {
                const decoder = new TextDecoder();
                const meta = JSON.parse(decoder.decode(r.metadataJson)) as Record<string, unknown>;
                evictionCue = typeof meta.eviction_cue === "string" ? meta.eviction_cue : undefined;
              } catch { /* best-effort */ }
            }
            const snippet = truncateSnippet(r.text);
            summaries.push({ summaryId: r.id, snippet, score: r.score, evictionCue });
            totalChars += snippet.length;
          }
        }

        if (scope === "messages" || scope === "both") {
          const searchK = Math.min(limit * 3, 200);
          const turnResults = await client.searchText({
            collection: `session_raw:${sessionId}`,
            text: pattern,
            k: searchK,
          });
          for (const r of (turnResults.results ?? [])) {
            if (turns.length >= limit || totalChars >= MAX_GREP_CHARS) break;
            if (!safeMatch(r.text, pattern, mode)) continue;
            totalMatches++;
            const snippet = truncateSnippet(r.text);
            let role = "unknown";
            if (r.metadataJson && r.metadataJson.length > 0) {
              try {
                const decoder = new TextDecoder();
                const meta = JSON.parse(decoder.decode(r.metadataJson)) as Record<string, unknown>;
                role = typeof meta.role === "string" ? meta.role : "unknown";
              } catch { /* best-effort */ }
            }
            turns.push({ turnId: r.id, snippet, role, score: r.score });
            totalChars += snippet.length;
          }
        }

        return jsonResult<MemoryGrepDetails>({
          pattern,
          mode,
          totalMatches,
          summaries,
          turns,
          truncated: totalChars >= MAX_GREP_CHARS,
        });
      } catch (error) {
        logger.warn?.(`memory_grep failed: ${formatError(error)}`);
        return jsonResult<MemoryGrepDetails>({
          pattern,
          mode,
          totalMatches: 0,
          summaries: [],
          turns: [],
          truncated: false,
        });
      }
    },
  };
}

// ── Prompt guidance ──

const RECALL_GUIDANCE = [
  "## LibraVDB Recall",
  "",
  "Summaries in context are compressed maps — not the details.",
  "Active session recall and summary expansion tools are available:",
  "",
  "**Tool escalation (cheap → expensive):**",
  "1. `memory_search` — semantic search across all memory/session collections.",
  "   Summary hits show `[Summary sum_xxx]: [cue with anchors, decisions, signals]`.",
  "   Use these cues to decide what's worth expanding.",
  "2. `memory_describe` — inspect a summary's metadata (cheap, no expansion).",
  "   Returns eviction cues with child count and source turn range.",
  "3. `memory_expand` — deep recall: walks the summary tree, returns full text.",
  "   Use this when the eviction cue suggests the detail you need is inside.",
  "4. `memory_grep` — search compacted history by text or regex pattern.",
  "   Returns matching snippets with summary/turn IDs for follow-up.",
  "",
  "**Many questions can be answered from eviction cues alone.**",
  "Only expand when the cue signals specific details worth the token cost.",
  "",
] as const;

export function memoryRecallPromptSection(): string[] {
  return [...RECALL_GUIDANCE];
}
