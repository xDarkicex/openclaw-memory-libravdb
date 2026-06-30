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
const USER_CARD_INDEX_VARIANT_SUFFIX_RE = /:(?:64d|256d)$/u;

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
    record_id: {
      type: "string",
      description: "Record ID for causal graph traversal. Use exact IDs from memory_search or memory_get results.",
    },
    maxDepth: {
      type: "number",
      minimum: 0,
      maximum: 5,
      description: "Max tree/graph traversal depth (default: 1). 0 returns only edge metadata.",
    },
    maxTokens: {
      type: "number",
      minimum: 100,
      maximum: Number(MAX_EXPAND_TOKENS),
      description: `Token budget cap for the expansion result (default: ${MAX_EXPAND_TOKENS}).`,
    },
    sessionId: {
      type: "string",
      description: "Session ID. If omitted, uses the current session.",
    },
  },
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
  getSessionId: () => string | undefined = () => undefined,
) {
  return {
    name: "memory_expand",
    label: "Memory Expand",
    description:
      "Expand compacted summaries OR walk causal graph edges from ANY record. " +
      "Summary mode (summaryIds): walk the summary tree up to maxDepth levels. " +
      "Graph mode (record_id): walk causal edges (why_ids/how_ids/hop_targets) " +
      "from a record ID. Use exact IDs from memory_search or memory_get results — " +
      "any ingested turn, memory, or summary has graph edges. " +
      "After get_user_card for context, search for related people/events then " +
      "expand the most relevant hit. " +
      "For large expansions, spawns a sub-agent. " +
      "Use memory_describe first to check if expansion is warranted.",
    parameters: MEMORY_EXPAND_SCHEMA,
    execute: async (_toolCallId: string, rawParams: unknown): Promise<ToolResult<MemoryExpandDetails>> => {
      const params = asParams(rawParams);
      const recordId = readStr(params, "record_id");
      const rawIds = params.summaryIds;
      const summaryIds: string[] = Array.isArray(rawIds) ? rawIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];

      const maxDepth = readNum(params, "maxDepth", { integer: true, min: 0 }) ?? 1;
      let maxTokens = readNum(params, "maxTokens", { integer: true }) ?? MAX_EXPAND_TOKENS;
      const sessionId = readStr(params, "sessionId") ?? getSessionId() ?? "";

      // Graph mode: walk causal edges from a record ID.
      if (recordId) {
        try {
          const client = await getClient();
          const resp = await client.expandSummary({ recordId, maxDepth });
          let text = resp.text ?? "";
          const connected = resp.connected;
          if (connected && connected.length > 0) {
            text = connected.map((c) =>
              `[depth=${c.depth}] ${c.recordId}: ${c.text || ""}`
            ).join("\n\n");
          }
          if (!text && resp.whyIds?.length) {
            text = `why_ids: ${resp.whyIds.join(", ")}\nhow_ids: ${resp.howIds?.join(", ") ?? "none"}\nhop_targets: ${resp.hopTargets?.join(", ") ?? "none"}`;
          }
          return {
            content: [{ type: "text", text: text || "(no graph edges found)" }],
            details: { summaryId: recordId, depth: maxDepth, text: text || "", truncated: false, exceededBudget: false, parentCount: connected?.length ?? 0 },
          };
        } catch (error) {
          logger.warn?.(`memory_expand graph mode failed: ${formatError(error)}`);
          return { content: [{ type: "text", text: `Graph expansion failed: ${formatError(error)}` }], details: { summaryId: recordId, depth: maxDepth, text: "", truncated: false, exceededBudget: false, parentCount: 0 } };
        }
      }

      if (summaryIds.length === 0) throw new Error("memory_expand requires at least one summaryId or record_id");

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
      "with summary/turn IDs for follow-up with memory_describe or memory_expand. " +
      "Do NOT call if the information is already visible in your context window " +
      "(from prior turns, <context_memory> blocks, or context assembly).",
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

// ── User Card tool schemas ──

const UPDATE_USER_CARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    user_id: {
      type: "string",
      description: "The user ID to update the card for.",
    },
    card: {
      type: "string",
      description: "Prose description of what you've learned about this person. Write like describing a friend. Include identity, values, history, communication style, triggers, and what matters to them. Merge with previous understanding — don't replace entirely unless the user explicitly contradicts the record. Max ~1200 characters.",
    },
  },
  required: ["user_id", "card"],
} as const;

const GET_USER_CARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    user_id: {
      type: "string",
      description: "The user ID to retrieve the card for.",
    },
  },
  required: ["user_id"],
} as const;

type UpdateUserCardDetails = { ok: boolean; error?: string };
type GetUserCardDetails = { card?: string | null; updatedAt?: number; version?: number; error?: string };
type UserCardLookupHit = { card: string | null; updatedAt?: number; version?: number };

// ── User Card tool factories ──

export function createUpdateUserCardTool(
  getClient: ClientGetter,
  logger: LoggerLike = console,
) {
  return {
    name: "update_user_card",
    label: "Update User Card",
    description:
      "Write what you've learned about a speaker. Prose format — write like you're describing a friend. " +
      "Include identity, values, history, communication style, triggers, and what matters to them. " +
      "This is the canonical record of who they are. If something changes, update it. " +
      "Merge with previous understanding, don't replace entirely unless the user explicitly contradicts the record.",
    parameters: UPDATE_USER_CARD_SCHEMA,
    execute: async (_toolCallId: string, rawParams: unknown): Promise<ToolResult<UpdateUserCardDetails>> => {
      try {
        const params = asParams(rawParams);
        const userId = readStr(params, "user_id");
        const card = readStr(params, "card");
        if (!userId) return jsonResult({ ok: false, error: "update_user_card requires user_id" });
        if (!card) return jsonResult({ ok: false, error: "update_user_card requires card" });

        const client = await getClient();
        const resp = await client.upsertUserCard({
          userId,
          cardJson: JSON.stringify({ card, updatedAt: Date.now() }),
        });
        return jsonResult({ ok: resp.ok });
      } catch (error) {
        logger.warn?.(`update_user_card failed: ${formatError(error)}`);
        return jsonResult({ error: formatError(error), ok: false });
      }
    },
  };
}

export function createGetUserCardTool(
  getClient: ClientGetter,
  logger: LoggerLike = console,
) {
  return {
    name: "get_user_card",
    label: "Get User Card",
    description:
      "MANDATORY identity/entity lookup. Call this BEFORE answering any question " +
      "about a person, pet, place, or named thing ('who/what is X', 'do I have X', " +
      "'tell me about X'). Returns the full prose identity card. " +
      "Do NOT answer from memory or training data. Call this tool FIRST. " +
      "For identity-only questions, answer from the card. For details/history/preferences " +
      "questions, call memory_search after the card when the card lacks profile notes.",
    parameters: GET_USER_CARD_SCHEMA,
    execute: async (_toolCallId: string, rawParams: unknown): Promise<ToolResult<GetUserCardDetails>> => {
      try {
        const params = asParams(rawParams);
        const userId = readStr(params, "user_id");
        if (!userId) return jsonResult({ card: null, error: "get_user_card requires user_id" });

        const client = await getClient();
        const resp = await client.getUserCard({ userId });
        const aliasHit = resp.cardJson ? null : await findUserCardByAlias(client, userId);
        if (aliasHit) {
          return jsonResult({
            card: aliasHit.card,
            updatedAt: aliasHit.updatedAt,
            version: aliasHit.version,
          });
        }
        return jsonResult({
          card: resp.cardJson || null,
          updatedAt: resp.updatedAt ? Number(resp.updatedAt) : undefined,
          version: resp.version || undefined,
        });
      } catch (error) {
        logger.warn?.(`get_user_card failed: ${formatError(error)}`);
        return jsonResult({ error: formatError(error) });
      }
    },
  };
}

// ── list_user_cards ─────────────────────────────────────────────────

type ListUserCardsDetails = {
  users: Array<{
    user_id: string;
    preview: string;
    updated_at?: number;
    version?: number;
  }>;
  total: number;
  error?: string;
};

type UserCardListEntry = ListUserCardsDetails["users"][number];
type UserCardListCandidate = UserCardListEntry & { isCanonicalSource: boolean };

function canonicalUserCardId(userId: string): string {
  return userId.replace(USER_CARD_INDEX_VARIANT_SUFFIX_RE, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function userCardIdMatchesLookup(storedUserId: string, requestedUserId: string): boolean {
  if (storedUserId === requestedUserId) return true;
  if (requestedUserId.includes("|")) return false;
  return new RegExp(`(?:^|\\|)sender=${escapeRegExp(requestedUserId)}(?:$|\\|)`, "u").test(storedUserId);
}

function readUserCardLookupHit(result: { metadataJson?: Uint8Array }): UserCardLookupHit | null {
  if (!result.metadataJson || result.metadataJson.length === 0) return null;
  try {
    const meta = JSON.parse(new TextDecoder().decode(result.metadataJson)) as Record<string, unknown>;
    const cardJson = typeof meta.card_json === "string" ? meta.card_json : null;
    if (!cardJson) return null;
    const card = JSON.parse(cardJson) as { card?: unknown; source?: unknown };
    if (typeof card.source === "string" && card.source !== "openclaw-user-cards") return null;
    return {
      card: typeof card.card === "string" ? card.card : cardJson,
      updatedAt: typeof meta.updated_at === "number" ? meta.updated_at : undefined,
      version: typeof meta.version === "number" ? meta.version : undefined,
    };
  } catch {
    return null;
  }
}

function shouldReplaceUserCardLookupHit(current: UserCardLookupHit, next: UserCardLookupHit): boolean {
  if ((next.version ?? 0) !== (current.version ?? 0)) return (next.version ?? 0) > (current.version ?? 0);
  if ((next.updatedAt ?? 0) !== (current.updatedAt ?? 0)) return (next.updatedAt ?? 0) > (current.updatedAt ?? 0);
  return !current.card && !!next.card;
}

function userCardAliasMatchesLookup(card: string | null, requestedUserId: string): boolean {
  if (!card || requestedUserId.includes("|")) return false;
  const requestedTokens = identityTokens(requestedUserId);
  if (requestedTokens.length === 0) return false;
  const cardTokens = identityTokens(extractUserCardIdentityText(card));
  if (cardTokens.length === 0) return false;
  return requestedTokens.every((token) => cardTokens.includes(token));
}

function extractUserCardIdentityText(card: string): string {
  return card
    .split(/\r?\n/u)
    .filter((line) =>
      /^(?:[-*]\s*)?(?:user card|known aliases|visible names|display names|aliases|name|username|speaker|speaker id|user id|provider|account type|channel id)\s*:/iu
        .test(line.trim())
    )
    .join("\n");
}

function identityTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/gu)?.filter((token) => token.length >= 3) ?? [];
}

async function findUserCardByAlias(client: Awaited<ReturnType<ClientGetter>>, userId: string): Promise<UserCardLookupHit | null> {
  const resp = await client.listByMeta({
    collection: "",
    key: "type",
    value: "user_card",
  });
  let best: UserCardLookupHit | null = null;
  for (const result of resp.results) {
    if (!result.metadataJson || result.metadataJson.length === 0) continue;
    let storedUserId = "";
    try {
      const meta = JSON.parse(new TextDecoder().decode(result.metadataJson)) as Record<string, unknown>;
      storedUserId = typeof meta._user_id === "string" ? canonicalUserCardId(meta._user_id) : "";
    } catch {
      continue;
    }
    const hit = readUserCardLookupHit(result);
    if (!storedUserId || !hit) continue;
    if (!userCardIdMatchesLookup(storedUserId, userId) && !userCardAliasMatchesLookup(hit.card, userId)) continue;
    if (!best || shouldReplaceUserCardLookupHit(best, hit)) best = hit;
  }
  return best;
}

function shouldReplaceUserCardListEntry(
  current: UserCardListCandidate,
  next: UserCardListCandidate,
): boolean {
  if (next.isCanonicalSource !== current.isCanonicalSource) return next.isCanonicalSource;
  if ((next.version ?? 0) !== (current.version ?? 0)) return (next.version ?? 0) > (current.version ?? 0);
  if ((next.updated_at ?? 0) !== (current.updated_at ?? 0)) return (next.updated_at ?? 0) > (current.updated_at ?? 0);
  return !current.preview && !!next.preview;
}

export function createListUserCardsTool(
  getClient: ClientGetter,
  logger: LoggerLike = console,
) {
  return {
    name: "list_user_cards",
    label: "List User Cards",
    description:
      "MANDATORY roster lookup. Call this BEFORE answering 'who do you know?', " +
      "'do I have X?', or any question where you're unsure if a card exists. " +
      "Returns all user IDs with previews. Then call get_user_card on relevant IDs. " +
      "Do NOT answer from memory — call this tool first.",
    parameters: { type: "object", additionalProperties: false, properties: {} } as const,
    execute: async (_toolCallId: string, _rawParams: unknown): Promise<ToolResult<ListUserCardsDetails>> => {
      try {
        const client = await getClient();
        const resp = await client.listByMeta({
          collection: "",
          key: "type",
          value: "user_card",
        });
        const usersById = new Map<string, UserCardListCandidate>();
        for (const result of resp.results) {
          let userId = "";
          let preview = "";
          let updatedAt: number | undefined;
          let version: number | undefined;
          if (result.metadataJson && result.metadataJson.length > 0) {
            try {
              const decoder = new TextDecoder();
              const meta = JSON.parse(decoder.decode(result.metadataJson)) as Record<string, unknown>;
              userId = typeof meta._user_id === "string" ? meta._user_id : "";
              const cardJson = typeof meta.card_json === "string" ? meta.card_json : null;
              if (cardJson) {
                try {
                  const card = JSON.parse(cardJson) as { card?: unknown; source?: unknown };
                  if (typeof card.source === "string" && card.source !== "openclaw-user-cards") {
                    userId = "";
                    continue;
                  }
                  preview = typeof card.card === "string" ? card.card : cardJson;
                }
                catch { preview = cardJson; }
                preview = preview.slice(0, 200);
              }
              updatedAt = typeof meta.updated_at === "number" ? meta.updated_at : undefined;
              version = typeof meta.version === "number" ? meta.version : undefined;
            } catch { /* best-effort metadata parse */ }
          }
          if (!userId) continue;
          const canonicalUserId = canonicalUserCardId(userId);
          const entry = {
            user_id: canonicalUserId,
            preview,
            updated_at: updatedAt,
            version,
            isCanonicalSource: userId === canonicalUserId,
          };
          const current = usersById.get(canonicalUserId);
          if (!current || shouldReplaceUserCardListEntry(current, entry)) {
            usersById.set(canonicalUserId, entry);
          }
        }
        const users = Array.from(usersById.values(), ({ isCanonicalSource: _isCanonicalSource, ...user }) => user);
        return jsonResult({ users, total: users.length });
      } catch (error) {
        logger.warn?.(`list_user_cards failed: ${formatError(error)}`);
        return jsonResult({ users: [], total: 0, error: formatError(error) });
      }
    },
  };
}

// ── Persona tools — identity of the bot itself ──

export function createSetPersonaTool(
  getClient: ClientGetter,
  logger: LoggerLike = console,
) {
  return {
    name: "set_persona",
    label: "Set Persona",
    description:
      "Define who YOU are — your personality, tone, boundaries, and behavior. " +
      "Write in prose like you're describing yourself. This is injected as " +
      "<bot_persona> at the start of every session. Update it when your persona " +
      "changes. The LLM will embody this persona in all interactions.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        persona: { type: "string", description: "Prose description of how you should behave." },
      },
      required: ["persona"],
    } as const,
    execute: async (_toolCallId: string, rawParams: unknown): Promise<ToolResult<{ ok: boolean; error?: string }>> => {
      const params = rawParams as Record<string, unknown> | undefined;
      const persona = typeof params?.persona === "string" ? params.persona.trim() : "";
      if (!persona) return jsonResult({ ok: false, error: "set_persona requires a persona string" });
      try {
        const client = await getClient();
        const resp = await client.upsertUserCard({
          userId: "__bot_persona__",
          cardJson: JSON.stringify({ card: persona, updatedAt: Date.now() }),
        });
        return jsonResult({ ok: resp.ok });
      } catch (error) {
        logger.warn?.(`set_persona failed: ${formatError(error)}`);
        return jsonResult({ ok: false, error: formatError(error) });
      }
    },
  };
}

export function createGetPersonaTool(
  getClient: ClientGetter,
  logger: LoggerLike = console,
) {
  return {
    name: "get_persona",
    label: "Get Persona",
    description: "Read your current persona. Returns the full prose description of how you should behave.",
    parameters: { type: "object", additionalProperties: false, properties: {} } as const,
    execute: async (): Promise<ToolResult<{ persona?: string | null; error?: string }>> => {
      try {
        const client = await getClient();
        const resp = await client.getUserCard({ userId: "__bot_persona__" });
        return jsonResult({ persona: resp.cardJson || null });
      } catch (error) {
        logger.warn?.(`get_persona failed: ${formatError(error)}`);
        return jsonResult({ error: formatError(error) });
      }
    },
  };
}
