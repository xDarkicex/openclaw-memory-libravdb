import type { PluginConfig } from "./types.js";

/** Per-registration agent exclusions for host hooks and tool factories. */
export function createAgentExclusionGuard(cfg: PluginConfig) {
  const agents = new Set((cfg.excludeAgents ?? []).map(id => id.trim()).filter(Boolean));
  const sessions = new Set<string>();
  const maxSessions = 1000;
  function context(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  }
  function text(value: unknown): string | undefined {
    return typeof value === "string" ? value.trim() || undefined : undefined;
  }
  return {
    isExcluded(value: unknown): boolean {
      if (!agents.size) return false;
      const ctx = context(value);
      const sessionId = text(ctx.sessionId);
      const agentId = /^agent:([^:]+):/.exec(text(ctx.sessionKey) ?? "")?.[1] ?? text(ctx.agentId);
      const excluded = agentId ? agents.has(agentId) : !!sessionId && sessions.has(sessionId);
      if (sessionId) {
        // Explicit allowed identities replace old bindings. Refresh excluded IDs
        // for later lifecycle events that carry only sessionId.
        sessions.delete(sessionId);
        if (excluded) {
          sessions.add(sessionId);
          if (sessions.size > maxSessions) sessions.delete(sessions.values().next().value!);
        }
      }
      return excluded;
    },
    forget(value: unknown): void {
      const sessionId = text(context(value).sessionId);
      if (sessionId) sessions.delete(sessionId);
    },
    clear(): void { sessions.clear(); },
  };
}
