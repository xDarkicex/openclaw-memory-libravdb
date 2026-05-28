import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginConfig } from "./types.js";
import type { ClientGetter } from "./plugin-runtime.js";

const MEMORY_PROMPT_HEADER = [
  "## Memory",
  "LibraVDB persistent memory is configured. Recalled memories may appear",
  "in context via the context-engine assembler when available and relevant.",
  "",
] as const;

function buildToolGuidance(availableTools: ReadonlySet<string> | undefined): string[] {
  if (!availableTools?.has("memory_search")) {
    return [];
  }
  const lines = [
    "For explicit memory lookup requests, call `memory_search` first.",
    "Use it for prior turns, remembered facts, earliest interactions, and channel history.",
  ];
  if (availableTools.has("memory_get")) {
    lines.push("After a `memory_search` hit, call `memory_get` when exact wording or more context is needed.");
  }
  lines.push(
    "Do not treat a missing `MEMORY.md` file as missing memory; LibraVDB memory is vector-backed and retrieved through the memory tools.",
    "",
  );
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
    // OpenClaw builds the memory prompt section synchronously for embedded runs.
    // Actual retrieval and ranking happen in the context engine during assemble().
    return [...MEMORY_PROMPT_HEADER, ...buildToolGuidance(availableTools)];
  };
}
