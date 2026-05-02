const SESSION_KEY_NAMESPACE_PREFIX = "session-key:";
const AGENT_ID_NAMESPACE_PREFIX = "agent-id:";

export type RetrievalScopes = {
  /** Always queried — fresh context bound to this session. */
  session: string;
  /** Cross-session durable memory. Null when disabled via config. */
  user: string | null;
  /** Shared knowledge. Queried but never written by this plugin. */
  global: string;
};

export function resolveDurableNamespace(params: {
  userId?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  fallback?: string;
}): string {
  const explicitUserId = firstNonEmpty(params.userId);
  if (explicitUserId) return explicitUserId;

  const sessionKey = firstNonEmpty(params.sessionKey);
  if (sessionKey) return `${SESSION_KEY_NAMESPACE_PREFIX}${sessionKey}`;

  const agentId = firstNonEmpty(params.agentId);
  if (agentId) return `${AGENT_ID_NAMESPACE_PREFIX}${agentId}`;

  return firstNonEmpty(params.fallback) ?? "default";
}

export function resolveScopes(params: {
  userId: string;
  sessionId?: string;
  crossSessionRecall?: boolean;
}): RetrievalScopes {
  return {
    session: params.sessionId ? `session:${params.sessionId}` : "session:default",
    user: params.crossSessionRecall !== false ? `user:${params.userId}` : null,
    global: "global",
  };
}

function firstNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
