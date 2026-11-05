import { isRuntimeSubagentExcluded } from "./context-engine.js";
import type { PluginRuntime } from "./plugin-runtime.js";

/** Consult live spawn ownership so rollback/end immediately releases a child. */
export function createSubagentExclusionGuard(runtime: PluginRuntime | null, enabled: boolean) {
  const sessions = new Map<string, string>();
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const context = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  runtime?.onShutdown(() => { sessions.clear(); });
  return {
    isExcluded(value: unknown): boolean {
      if (!enabled || !runtime) return false;
      const ctx = context(value);
      const sessionId = text(ctx.sessionId);
      const key = text(ctx.sessionKey) || sessions.get(sessionId);
      const excluded = !!key && isRuntimeSubagentExcluded(runtime, key);
      if (sessionId) {
        sessions.delete(sessionId);
        if (excluded && key) {
          sessions.set(sessionId, key);
          if (sessions.size > 1000) sessions.delete(sessions.keys().next().value!);
        }
      }
      return excluded;
    },
    forget(value: unknown): void { sessions.delete(text(context(value).sessionId)); },
  };
}
