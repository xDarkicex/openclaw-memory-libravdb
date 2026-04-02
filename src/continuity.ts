export const DEFAULT_CONTINUITY_MIN_TURNS = 4;
export const DEFAULT_CONTINUITY_TAIL_BUDGET_TOKENS = 128;
export const DEFAULT_CONTINUITY_PRIOR_CONTEXT_TOKENS = 96;

export interface RecentTailSelection<T> {
  older: T[];
  base: T[];
  recent: T[];
  baseTokens: number;
  recentTokens: number;
}

export function selectRecentTail<T>(
  items: T[],
  {
    minTurns = DEFAULT_CONTINUITY_MIN_TURNS,
    tailBudgetTokens = DEFAULT_CONTINUITY_TAIL_BUDGET_TOKENS,
    tokenCost,
    sameBundle,
  }: {
    minTurns?: number;
    tailBudgetTokens?: number;
    tokenCost: (item: T) => number;
    sameBundle?: (left: T, right: T) => boolean;
  },
): RecentTailSelection<T> {
  if (items.length === 0 || minTurns <= 0) {
    return {
      older: [...items],
      base: [],
      recent: [],
      baseTokens: 0,
      recentTokens: 0,
    };
  }

  const normalizedMinTurns = Math.max(1, Math.floor(minTurns));
  const normalizedTailBudget = Math.max(0, Math.floor(tailBudgetTokens));
  const baseStart = Math.max(0, items.length - normalizedMinTurns);
  const base = items.slice(baseStart);
  const baseTokens = tokenCostSum(base, tokenCost);

  if (baseTokens > normalizedTailBudget) {
    const recentStart = extendBundleBoundary(items, baseStart, sameBundle);
    const recent = items.slice(recentStart);
    return {
      older: items.slice(0, recentStart),
      base,
      recent,
      baseTokens,
      recentTokens: tokenCostSum(recent, tokenCost),
    };
  }

  let start = baseStart;
  let used = baseTokens;
  for (let i = baseStart - 1; i >= 0; i -= 1) {
    const nextCost = tokenCost(items[i]!);
    if (used + nextCost > normalizedTailBudget) {
      break;
    }
    used += nextCost;
    start = i;
  }
  start = extendBundleBoundary(items, start, sameBundle);
  const recent = items.slice(start);

  return {
    older: items.slice(0, start),
    base,
    recent,
    baseTokens,
    recentTokens: tokenCostSum(recent, tokenCost),
  };
}

function tokenCostSum<T>(items: T[], tokenCost: (item: T) => number): number {
  return items.reduce((sum, item) => sum + tokenCost(item), 0);
}

function extendBundleBoundary<T>(
  items: T[],
  start: number,
  sameBundle?: (left: T, right: T) => boolean,
): number {
  if (!sameBundle) {
    return start;
  }
  while (start > 0 && sameBundle(items[start - 1]!, items[start]!)) {
    start -= 1;
  }
  return start;
}
