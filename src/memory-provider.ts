import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginConfig } from "./types.js";
import type { ClientGetter } from "./plugin-runtime.js";

const MEMORY_PROMPT_HEADER = [
  "## Memory",
  "LibraVDB persistent memory is configured. When asked about past",
  "conversations, facts, preferences, decisions, or anything a user",
  "might have told you before — actively retrieve it.",
  "",
] as const;

function buildToolGuidance(availableTools: ReadonlySet<string> | undefined): string[] {
  if (!availableTools?.has("memory_search")) {
    return [];
  }
  return [
    "Call `memory_search` for prior turns, remembered facts, earliest interactions,",
    "and channel history. Do not answer memory questions from prior transcript",
    "claims or stale `memory_search` results — perform a fresh search every time.",
    "For earliest or oldest questions, request enough results and compare timestamps.",
    ...(availableTools.has("memory_get")
      ? ["After a `memory_search` hit, call `memory_get` when exact wording or more context is needed."]
      : []),
    "LibraVDB memory is vector-backed and retrieved through tools, not files.",
    "",
  ];
}

export function buildMemoryPromptSection(
  _getClient: ClientGetter,
  _cfg: PluginConfig,
): MemoryPromptSectionBuilder {
  return function memoryPromptSection({
    availableTools,
    citationsMode: _citationsMode,
  }): string[] {
    // OpenClaw builds the memory prompt section synchronously for embedded runs.
    // Actual retrieval and ranking happen in the context engine during assemble().
    return [...MEMORY_PROMPT_HEADER, ...buildToolGuidance(availableTools)];
  };
}
