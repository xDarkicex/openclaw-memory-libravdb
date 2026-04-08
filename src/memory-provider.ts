import type { PluginConfig, RecallCache, SearchResult } from "./types.js";
import type { RpcGetter } from "./plugin-runtime.js";

const MEMORY_PROMPT_HEADER = [
  "## Memory",
  "LibraVDB persistent memory is active. Recalled memories will appear",
  "in context via the context-engine assembler when relevant.",
  "",
] as const;

export function buildMemoryPromptSection(
  _getRpc: RpcGetter,
  _cfg: PluginConfig,
  _recallCache: RecallCache<SearchResult>,
): (params: {
  availableTools: Set<string>;
  citationsMode?: string;
  messages?: Array<{ role: string; content: string }>;
  userId?: string;
}) => string[] {
  return function memoryPromptSection(_params: {
    availableTools: Set<string>;
    citationsMode?: string;
    messages?: Array<{ role: string; content: string }>;
    userId?: string;
  }): string[] {
    // OpenClaw builds the memory prompt section synchronously for embedded runs.
    // Actual retrieval and ranking happen in the context engine during assemble().
    return [...MEMORY_PROMPT_HEADER];
  };
}
