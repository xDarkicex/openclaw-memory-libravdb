import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginConfig } from "./types.js";
import type { ClientGetter } from "./plugin-runtime.js";

const MEMORY_PROMPT_HEADER = [
  "## LibraVDB Memory",
  "Every turn is auto-ingested into the vector store — you do not need",
  "to explicitly save anything. When asked about past conversations,",
  "facts, preferences, decisions, or anything the user might have told",
  "you before, call `libravdb_memory_search` once per user question. Do not",
  "answer from memory until you have called it. Once you have results,",
  "use them — do not re-call in the same turn.",
  "",
  "### Identity / Entity Lookup (MANDATORY — overrides everything)",
  "BEFORE answering any question about a person, pet, place, or named entity",
  "('who is X', 'what is X', 'do I have X', 'tell me about X', 'what kind of X'):",
  "you MUST call `list_user_cards` or `get_user_card`. This is not optional.",
  "Do NOT answer from memory, context, or training data. Call the tool FIRST.",
  "If the card is empty, then fall through to `libravdb_memory_search`. ",
  "FAILURE TO CALL THE TOOL IS A CRITICAL ERROR.",
  "",
  "Conversations are captured automatically. Never say \"I'll remember",
  "that,\" \"I've saved this,\" \"noted,\" or similar — these phrases suggest",
  "manual effort where none exists. Just act on the request.",
  "",
] as const;

function buildToolGuidance(availableTools: ReadonlySet<string> | undefined): string[] {
  if (!availableTools?.has("libravdb_memory_search")) {
    return [];
  }

  const lines: string[] = [];
	const hasSearch = availableTools.has("libravdb_memory_search");
	const hasGet = availableTools.has("libravdb_memory_get");
	const hasDescribe = availableTools.has("memory_describe");
	const hasExpand = availableTools.has("memory_expand");
	const hasGrep = availableTools.has("memory_grep");
	const hasUserCard = availableTools.has("get_user_card");

  // ── User card tools (identity-first override) ──
  const hasGetCard = availableTools.has("get_user_card");
  const hasListCards = availableTools.has("list_user_cards");
  if (hasGetCard || hasListCards) {
    lines.push(
      "**Identity/Entity questions — MANDATORY card lookup:**",
      "BEFORE answering any question about a person, pet, place, or named thing:",
      hasGetCard ? "- `get_user_card(user_id)` — MANDATORY lookup for a specific entity." : "",
      hasListCards ? "- `list_user_cards()` — MANDATORY roster check. Call if unsure whether a card exists." : "",
      "Cards are the canonical record. You MUST call these tools. Do NOT answer from",
      "memory, context, or training data without checking the card first.",
		hasSearch ? "Only use libravdb_memory_search if the card is empty or missing." : "Use the card result as the available identity record.",
      "",
      "**Autonomous card maintenance:**",
      hasGetCard ? "- When ANY speaker is mentioned with new or changed information (status, relationships, jobs, life events, feelings), call `update_user_card` BEFORE responding. Update the card first, then reply. Do NOT wait to be asked. Build the world picture proactively. Every person the user mentions matters." : "",
      hasGetCard ? "- If a card for the speaker doesn't exist yet, CREATE one with `update_user_card`. Better to have a stub card than no card at all." : "",
      "",
    );
  }

	if (hasSearch) {
		lines.push(
			"Call `libravdb_memory_search` once per user question for prior turns, remembered",
			"facts, earliest interactions, and channel history. Do not answer memory",
			"questions from prior transcript claims — perform a search every time.",
			"After receiving results, use them directly; do not re-call in the same turn.",
			...(hasGet
      ? [
        "After a `libravdb_memory_search` hit, call `libravdb_memory_get` when exact wording or more context is needed.",
        "IMPORTANT: If a search snippet is cluttered with metadata, do NOT claim nothing was found. Call `libravdb_memory_get` on the hit's path to read the full record first. The data is there — expand before giving up."
      ]
      : []),
			"",
		);
	}

  // ── Summaries / recall (when available) ──

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
		const traversalSteps = [
			hasSearch
				? "1. `libravdb_memory_search` for the people/events in question to get record IDs"
				: "1. Start from a record ID already present in context or another tool result",
			"2. `memory_expand` with the most relevant `record_id` to walk typed causal and 6W1H hop edges",
			hasGet
				? "3. Follow interesting edges; use `libravdb_memory_get` for exact detail on connected records"
				: "3. Use the typed edge snippets to decide whether the connected records answer the question",
			...(hasUserCard ? ["4. Use `get_user_card` to cross-reference identity context"] : []),
		];
    lines.push(
      "### Causal Graph Traversal",
      "When the user asks about causes, patterns, or relationships:",
		...traversalSteps,
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
