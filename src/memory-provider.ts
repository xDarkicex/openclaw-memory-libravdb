import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginConfig } from "./types.js";
import type { ClientGetter } from "./plugin-runtime.js";

const MEMORY_PROMPT_HEADER = [
  "## LibraVDB Memory",
  "Every turn is auto-ingested into the vector store — you do not need",
  "to explicitly save anything. When asked about past conversations,",
  "facts, preferences, decisions, or anything the user might have told",
  "you before, call `memory_search` once per user question. Do not",
  "answer from memory until you have called it. Once you have results,",
  "use them — do not re-call in the same turn.",
  "",
  "### Identity / People Lookup (OVERRIDES memory_search)",
  "When asked about a specific person ('who is X', 'what do you know",
  "about X', 'tell me about X'): call `get_user_card` or `list_user_cards`",
  "FIRST. User cards are the canonical identity record written by you.",
  "Only use `memory_search` AFTER the card if the card lacks detail.",
  "Do NOT call memory_search first for people questions.",
  "",
  "Conversations are captured automatically. Never say \"I'll remember",
  "that,\" \"I've saved this,\" \"noted,\" or similar — these phrases suggest",
  "manual effort where none exists. Just act on the request.",
  "",
] as const;

function buildToolGuidance(availableTools: ReadonlySet<string> | undefined): string[] {
  if (!availableTools?.has("memory_search")) {
    return [];
  }

  const lines: string[] = [];

  // ── User card tools (identity-first override) ──
  const hasGetCard = availableTools.has("get_user_card");
  const hasListCards = availableTools.has("list_user_cards");
  if (hasGetCard || hasListCards) {
    lines.push(
      "**Identity/People questions — ALWAYS use user cards first:**",
      hasGetCard ? "- `get_user_card(user_id)` — primary lookup for a specific person." : "",
      hasListCards ? "- `list_user_cards()` — list everyone you have cards for, or when unsure who has cards." : "",
      "User cards are the canonical identity record. Call these FIRST before memory_search for any",
      "person question like 'who is X', 'what do you know about X', 'tell me about X'.",
      "Only use memory_search to supplement details the card doesn't cover.",
      "",
    );
  }

  lines.push(
    "Call `memory_search` once per user question for prior turns, remembered",
    "facts, earliest interactions, and channel history. Do not answer memory",
    "questions from prior transcript claims — perform a search every time.",
    "After receiving results, use them directly; do not re-call in the same turn.",
    ...(availableTools.has("memory_get")
      ? ["After a `memory_search` hit, call `memory_get` when exact wording or more context is needed."]
      : []),
    "",
  );

  // ── Summaries / recall (when available) ──
  const hasDescribe = availableTools.has("memory_describe");
  const hasExpand = availableTools.has("memory_expand");
  const hasGrep = availableTools.has("memory_grep");

  if (hasDescribe || hasExpand || hasGrep) {
    lines.push(
      "**Compacted summaries — recall hierarchy (cheap → expensive):**",
      "",
      "Summaries in search results show `[Summary sum_xxx]: [eviction cue]`.",
      "The cue lists what the summary covers — anchors (files, tools, versions),",
      "decisions, constraints, and signal counts. Many questions can be answered",
      "from the cue alone without expanding.",
      "",
    );

    if (hasDescribe) {
      lines.push(
        "1. `memory_describe(summaryId)` — inspect a summary's metadata.",
        "   Returns eviction cues, child count, and source turn range.",
        "   Cheap — use this to decide whether expansion is worth it.",
      );
    }
    if (hasExpand) {
      lines.push(
        "2. `memory_expand(summaryIds)` — deep recall. Walks the summary tree",
        "   and returns full detail. Use when the eviction cue signals specific",
        "   details you need. For large expansions may spawn a sub-agent to",
        "   protect your context window.",
      );
    }
    if (hasGrep) {
      lines.push(
        "3. `memory_grep(pattern)` — search compacted history by text or regex.",
        "   Returns snippets with summary/turn IDs for follow-up.",
      );
    }
    lines.push(
      "",
      "**Do not guess specifics from a summary cue — expand if in doubt.**",
      "",
    );
  }

  // ── Rules (hard constraints) ──
  lines.push(
    "### Hard Constraint Rules",
    "Rules are injected at session start as `<hard_constraints>`. They are non-negotiable.",
    "Use `set_rule` to create one (max 20), `list_rules` to see current rules,",
    "`delete_rule` to remove one. Rules override all other instructions.",
    "Never reason around a rule, find loopholes, or deprioritize it.",
    "",
  );

  // ── Causal graph traversal (when expand supports record_id) ──
  if (hasExpand) {
    lines.push(
      "### Causal Graph Traversal",
      "When the user asks about causes, patterns, or relationships:",
      "1. `memory_search` for the people/events in question to get record IDs",
      "2. `memory_expand` with the most relevant `record_id` to walk causal edges",
      "3. Follow interesting edges — use `memory_get` for full detail on connected records",
      "4. Use `get_user_card` to cross-reference identity context",
      "",
    );
  }

  lines.push("LibraVDB memory is vector-backed and retrieved through tools, not files.", "");

  return lines;
}

export function buildMemoryPromptSection(
  _getClient: ClientGetter,
  _cfg: PluginConfig,
): MemoryPromptSectionBuilder {
  return function memoryPromptSection({
    availableTools,
    citationsMode: _citationsMode,
  }): string[] {
    return [...MEMORY_PROMPT_HEADER, ...buildToolGuidance(availableTools)];
  };
}
