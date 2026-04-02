export const DEFAULT_CONTINUITY_MIN_TURNS = 4;
export const DEFAULT_CONTINUITY_TAIL_BUDGET_TOKENS = 128;

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
  }: {
    minTurns?: number;
    tailBudgetTokens?: number;
    tokenCost: (item: T) => number;
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
    return {
      older: items.slice(0, baseStart),
      base,
      recent: base,
      baseTokens,
      recentTokens: baseTokens,
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

  return {
    older: items.slice(0, start),
    base,
    recent: items.slice(start),
    baseTokens,
    recentTokens: used,
  };
}

function tokenCostSum<T>(items: T[], tokenCost: (item: T) => number): number {
  return items.reduce((sum, item) => sum + tokenCost(item), 0);
}
