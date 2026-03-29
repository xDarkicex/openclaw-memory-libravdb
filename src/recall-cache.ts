import type { RecallCache, RecallCacheEntry } from "./types.js";

export function createRecallCache<T = unknown>(): RecallCache<T> {
  const entries = new Map<string, RecallCacheEntry<T>>();

  return {
    put(entry) {
      entries.set(cacheKey(entry.userId, entry.queryText), entry);
    },
    take(key) {
      const id = cacheKey(key.userId, key.queryText);
      const hit = entries.get(id);
      if (hit) {
        entries.delete(id);
      }
      return hit;
    },
  };
}

function cacheKey(userId: string, queryText: string): string {
  return `${userId}\n${queryText}`;
}
