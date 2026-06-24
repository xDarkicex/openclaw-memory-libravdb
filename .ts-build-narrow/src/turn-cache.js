const DEFAULT_MAX_SIZE = 100;
class MemoryCache {
    cache = new Map();
    maxSize;
    constructor(maxSize = DEFAULT_MAX_SIZE) {
        this.maxSize = maxSize;
    }
    get(key) {
        const entry = this.cache.get(key);
        if (!entry)
            return undefined;
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.value;
    }
    set(key, value) {
        if (this.cache.has(key))
            this.cache.delete(key);
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined)
                this.cache.delete(firstKey);
        }
        this.cache.set(key, { value, timestamp: Date.now() });
    }
    invalidate(prefix) {
        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix))
                this.cache.delete(key);
        }
    }
    get size() {
        return this.cache.size;
    }
}
export class TurnMemoryCache {
    cache = new MemoryCache();
    constructor(maxSize = DEFAULT_MAX_SIZE) {
        this.cache = new MemoryCache(maxSize);
    }
    cacheKey(sessionId, queryHint) {
        return `${sessionId}:${this.normalize(queryHint)}`;
    }
    normalize(text) {
        return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
    }
    get(sessionId, queryHint) {
        return this.cache.get(this.cacheKey(sessionId, queryHint));
    }
    set(sessionId, queryHint, value) {
        this.cache.set(this.cacheKey(sessionId, queryHint), value);
    }
    invalidateSession(sessionId) {
        this.cache.invalidate(sessionId + ":");
    }
    get size() {
        return this.cache.size;
    }
}
function contentHash(msg) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        const ch = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + ch;
        hash |= 0;
    }
    return String(hash);
}
export function isNewUserTurn(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const role = messages[i].role;
        if (role === "user")
            return true;
        if (role === "assistant" || role === "toolResult")
            return false;
    }
    return true;
}
export function detectNewTurn(messages, lastUserMessageHash) {
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
export function extractQueryHint(messages, stripSenderMetadata) {
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
