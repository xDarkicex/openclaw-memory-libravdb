const SESSION_KEY_NAMESPACE_PREFIX = "session-key:";
const AGENT_ID_NAMESPACE_PREFIX = "agent-id:";
const USER_COLLECTION_PREFIX = "user:";

/** Valid collection names: alphanumeric, underscores, hyphens, dots, colons, at-signs, hashes.
 *  Must start with a letter. Max 128 characters. */
const COLLECTION_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.:@#-]{0,127}$/;

/** Validate and return a collection-safe namespace.
 *  Throws on invalid characters or length. */
export function validateNamespace(name: string): string {
  if (!COLLECTION_NAME_RE.test(name)) {
    throw new Error(
      `Invalid collection namespace: "${name}". Must match ${COLLECTION_NAME_RE.source}`,
    );
  }
  return name;
}

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
  if (explicitUserId) return validateNamespace(explicitUserId);

  const sessionKey = firstNonEmpty(params.sessionKey);
  if (sessionKey) return validateNamespace(`${SESSION_KEY_NAMESPACE_PREFIX}${sessionKey}`);

  const agentId = firstNonEmpty(params.agentId);
  if (agentId) return validateNamespace(`${AGENT_ID_NAMESPACE_PREFIX}${agentId}`);

  const fallback = firstNonEmpty(params.fallback);
  if (fallback) return validateNamespace(fallback);

  return "default";
}

export function resolveUserCollection(userId: string): string {
  const namespace = firstNonEmpty(userId);
  if (!namespace) {
    throw new Error("Invalid user collection namespace: userId must be non-empty");
  }
  validateNamespace(namespace);
  return validateNamespace(`${USER_COLLECTION_PREFIX}${namespace}`);
}

export function resolveScopes(params: {
  userId: string;
  sessionId?: string;
  crossSessionRecall?: boolean;
}): RetrievalScopes {
  return {
    session: params.sessionId ? `session:${params.sessionId}` : "session:default",
    user: params.crossSessionRecall !== false ? resolveUserCollection(params.userId) : null,
    global: "global",
  };
}

function firstNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
