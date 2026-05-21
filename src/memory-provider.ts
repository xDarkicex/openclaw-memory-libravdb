import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginConfig } from "./types.js";
import type { ClientGetter } from "./plugin-runtime.js";

const MEMORY_PROMPT_HEADER = [
  "## Memory",
  "LibraVDB persistent memory is configured. Recalled memories may appear",
  "in context via the context-engine assembler when available and relevant.",
  "",
] as const;

export function buildMemoryPromptSection(
  _getClient: ClientGetter,
  _cfg: PluginConfig,
): MemoryPromptSectionBuilder {
  return function memoryPromptSection({
    availableTools: _availableTools,
    citationsMode: _citationsMode,
  }): string[] {
    // OpenClaw builds the memory prompt section synchronously for embedded runs.
    // Actual retrieval and ranking happen in the context engine during assemble().
    return [...MEMORY_PROMPT_HEADER];
  };
}
