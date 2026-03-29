/**
 * Builds the memory prompt section for the agent system prompt.
 *
 * As of OpenClaw 2026.3.28 the MemoryPromptSectionBuilder contract changed:
 *   - Params: { availableTools: Set<string>, citationsMode?: string }
 *   - Return: string[]  (lines to splice into the system prompt)
 *
 * Heavy recall (per-query vector search, scoring, budget fitting) is handled
 * by the context engine's `assemble` hook, not here.  This builder only emits
 * a short static section that tells the model LibraVDB memory is active.
 */
export function buildMemoryPromptSection(): (params: {
  availableTools: Set<string>;
  citationsMode?: string;
}) => string[] {
  return function memoryPromptSection(_params) {
    return [
      "## Memory",
      "LibraVDB persistent memory is active. Recalled memories will appear",
      "in context via the context-engine assembler when relevant.",
      "",
    ];
  };
}
