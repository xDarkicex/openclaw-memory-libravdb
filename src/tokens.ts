import type { SearchResult } from "./types.js";

export function estimateTokens(text: string): number {
  const charsPerToken = detectCharsPerToken(text);
  return Math.ceil(text.length / charsPerToken);
}

export function fitPromptBudget(items: SearchResult[], budget: number): SearchResult[] {
  const selected: SearchResult[] = [];
  let used = 0;

  for (const item of items) {
    const cost = estimateTokens(item.text);
    if (used + cost > budget) {
      break;
    }
    selected.push(item);
    used += cost;
  }

  return selected;
}

export function fitPromptBudgetFirstFit(items: SearchResult[], budget: number): SearchResult[] {
  const selected: SearchResult[] = [];
  let used = 0;

  for (const item of items) {
    const cost = estimateTokens(item.text);
    if (used + cost > budget) {
      continue;
    }
    selected.push(item);
    used += cost;
  }

  return selected;
}

export function countTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);
}

function detectCharsPerToken(text: string): number {
  if (/[一-龯ぁ-ゖァ-ヺ가-힣]/u.test(text)) {
    return 1.6;
  }
  if (/[Ѐ-ӿ؀-ۿ֐-׿]/u.test(text)) {
    return 2.5;
  }
  return 4.0;
}
