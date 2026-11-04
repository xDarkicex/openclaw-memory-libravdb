const DEFAULT_MAX_SIZE = 100;

interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

class MemoryCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;

  constructor(maxSize = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.cache.has(key)) this.cache.delete(key);
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  invalidate(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  get size(): number {
    return this.cache.size;
  }
}

type AgentMessage = {
  role: string;
  content: string | unknown[];
  id?: string;
};

export class TurnMemoryCache {
  private cache = new MemoryCache<unknown>();

  constructor(maxSize = DEFAULT_MAX_SIZE) {
    this.cache = new MemoryCache<unknown>(maxSize);
  }

  private cacheKey(sessionId: string, queryHint: string): string {
    return `${JSON.stringify(sessionId)}:${this.normalize(queryHint)}`;
  }

  private normalize(text: string): string {
    return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
  }

  get(sessionId: string, queryHint: string): unknown | undefined {
    return this.cache.get(this.cacheKey(sessionId, queryHint));
  }

  set(sessionId: string, queryHint: string, value: unknown): void {
    this.cache.set(this.cacheKey(sessionId, queryHint), value);
  }

  invalidateSession(sessionId: string): void {
    this.cache.invalidate(`${JSON.stringify(sessionId)}:`);
  }

  get size(): number {
    return this.cache.size;
  }
}

function contentHash(msg: AgentMessage): string {
  const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return String(hash);
}

export function isNewUserTurn(messages: AgentMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i].role;
    if (role === "user") return true;
    if (role === "assistant" || role === "toolResult") return false;
  }
  return true;
}

export function detectNewTurn(
  messages: AgentMessage[],
  lastUserMessageHash: { current: string | null },
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const hash = contentHash(messages[i]);
      if (hash !== lastUserMessageHash.current) {
        lastUserMessageHash.current = hash;
        return true;
      }
      return false;
    }
  }
  return false;
}

export function extractQueryHint(messages: AgentMessage[], stripSenderMetadata: (text: string) => string): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const raw = messages[i].content;
      const content = typeof raw === "string" ? raw : JSON.stringify(raw) ?? "";
      const cleaned = stripSenderMetadata(content);
      return cleaned.slice(0, 200);
    }
  }
  return null;
}
