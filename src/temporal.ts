import type { SearchResult } from "./types.js";

const TEMPORAL_PATTERN_WEIGHTS: Array<{ label: string; weight: number; patterns: RegExp[] }> = [
  {
    label: "how many days",
    weight: 1.0,
    patterns: [/\bhow\s+many\s+days\b/i],
  },
  {
    label: "how long",
    weight: 0.9,
    patterns: [/\bhow\s+long\b/i],
  },
  {
    label: "before or after",
    weight: 0.8,
    patterns: [/\bbefore\b/i, /\bafter\b/i],
  },
  {
    label: "since or between",
    weight: 0.7,
    patterns: [/\bsince\b/i, /\bbetween\b/i],
  },
  {
    label: "first or earlier",
    weight: 0.8,
    patterns: [/\bfirst\b/i, /\bearlier\b/i, /\bwhich\s+came\s+first\b/i],
  },
  {
    label: "when did",
    weight: 0.7,
    patterns: [/\bwhen\s+did\b/i],
  },
];

const TEMPORAL_ANCHOR_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/gi,
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
  /\b(?:today|yesterday|tomorrow|last\s+(?:week|month|year|night|saturday|sunday)|next\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|mid-?[a-z]+)\b/gi,
  /\b\d{1,2}:\d{2}(?:\s?[ap]m)?\b/gi,
  /\b\d{10,13}\b/g,
];

const TEMPORAL_XI_NORM = 1.5;
const TEMPORAL_XI_THRESHOLD = 0.3;
const TEMPORAL_ANCHOR_NORM = 3;
const TEMPORAL_ANCHOR_CACHE_MAX = 4096;
const temporalAnchorCache = new Map<string, number>();

const TEMPORAL_SLOT_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "have",
  "from",
  "your",
  "what",
  "when",
  "where",
  "which",
  "would",
  "could",
  "should",
  "about",
  "into",
  "some",
  "them",
  "they",
  "been",
  "just",
  "want",
  "looking",
  "look",
  "help",
  "need",
  "recommend",
  "suggestions",
  "suggest",
  "advice",
  "think",
  "also",
  "did",
  "does",
  "do",
  "after",
  "before",
  "since",
  "between",
  "first",
  "earlier",
  "many",
  "days",
  "long",
  "how",
  "did",
  "take",
  "took",
  "it",
  "me",
  "my",
  "i",
]);

export interface TemporalQuerySignal {
  indicator: number;
  active: boolean;
  matchedPatterns: string[];
}

export interface TemporalRecoveryDebugCandidate {
  id: string;
  text: string;
  selected: boolean;
  temporalAnchorDensity: number;
  semanticScore: number;
  recencyScore: number;
  slotCoverage: number;
  slotMatches: string[];
  finalScore: number;
  rationale: string;
}

export interface TemporalRecoveryRankingResult {
  ranked: SearchResult[];
  debug: TemporalRecoveryDebugCandidate[];
  temporalQuery: TemporalQuerySignal;
  slots: string[];
}

export function detectTemporalQuerySignal(queryText: string): TemporalQuerySignal {
  const matchedPatterns: string[] = [];
  let weightedMatches = 0;

  for (const entry of TEMPORAL_PATTERN_WEIGHTS) {
    if (entry.patterns.some((pattern) => pattern.test(queryText))) {
      matchedPatterns.push(entry.label);
      weightedMatches += entry.weight;
    }
  }

  const indicator = clamp01(weightedMatches / TEMPORAL_XI_NORM);
  return {
    indicator,
    active: indicator >= TEMPORAL_XI_THRESHOLD,
    matchedPatterns,
  };
}

export function getTemporalAnchorDensity(docKey: string, text: string): number {
  const cacheKey = `${docKey}\n${text}`;
  const cached = temporalAnchorCache.get(cacheKey);
  if (typeof cached === "number") {
    touchTemporalAnchorCache(cacheKey, cached);
    return cached;
  }

  const uniqueMatches = new Set<string>();
  for (const pattern of TEMPORAL_ANCHOR_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0]?.trim().toLowerCase();
      if (value) {
        uniqueMatches.add(value);
      }
    }
  }

  const density = clamp01(uniqueMatches.size / TEMPORAL_ANCHOR_NORM);
  touchTemporalAnchorCache(cacheKey, density);
  return density;
}

export function rankTemporalRecoveryCandidates(
  items: SearchResult[],
  opts: {
    queryText: string;
    maxSelected?: number;
    nowMs?: number;
    recencyLambda?: number;
  },
): TemporalRecoveryRankingResult {
  const temporalQuery = detectTemporalQuerySignal(opts.queryText);
  const slots = extractTemporalSlots(opts.queryText);
  const recencyLambda = Math.max(0, opts.recencyLambda ?? 0.00001);
  const now = opts.nowMs ?? Date.now();
  const maxSelected = Math.max(1, Math.floor(opts.maxSelected ?? 3));

  const decorated = items.map((item) => {
    const semanticScore = clamp01(typeof item.finalScore === "number" ? item.finalScore : item.score ?? 0);
    const recencyScore = computeRecencyScore(item, now, recencyLambda);
    const temporalAnchorDensity = getTemporalAnchorDensity(
      `${typeof item.metadata.collection === "string" ? item.metadata.collection : "unknown"}::${item.id}`,
      item.text,
    );
    const { coverage, matches } = computeSlotCoverage(slots, item.text);
    const finalScore = clamp01(
      (0.40 * semanticScore) +
      (0.25 * recencyScore) +
      (0.20 * temporalAnchorDensity) +
      (0.15 * coverage) +
      (temporalQuery.active ? 0.05 : 0),
    );
    return {
      item,
      semanticScore,
      recencyScore,
      temporalAnchorDensity,
      slotCoverage: coverage,
      slotMatches: matches,
      finalScore,
    };
  });

  const selectedIDs = new Set<string>();
  const coveredSlots = new Set<string>();
  const selected: SearchResult[] = [];

  for (let pass = 0; pass < maxSelected; pass += 1) {
    let best: (typeof decorated)[number] | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of decorated) {
      if (selectedIDs.has(candidate.item.id)) {
        continue;
      }
      const marginalCoverage = candidate.slotMatches.filter((slot) => !coveredSlots.has(slot)).length / Math.max(1, slots.length);
      const combined = candidate.finalScore + (0.25 * marginalCoverage);
      if (combined > bestScore) {
        best = candidate;
        bestScore = combined;
      }
    }

    if (!best || bestScore < 0.12) {
      break;
    }

    selectedIDs.add(best.item.id);
    for (const slot of best.slotMatches) {
      coveredSlots.add(slot);
    }
    selected.push({
      ...best.item,
      finalScore: best.finalScore,
    });
  }

  const remaining = decorated
    .filter((candidate) => !selectedIDs.has(candidate.item.id))
    .sort((left, right) => right.finalScore - left.finalScore)
    .map((candidate) => ({
      ...candidate.item,
      finalScore: candidate.finalScore,
    }));

  const ranked = [...selected, ...remaining];
  const debug = decorated
    .sort((left, right) => right.finalScore - left.finalScore)
    .map((candidate) => ({
      id: candidate.item.id,
      text: candidate.item.text,
      selected: selectedIDs.has(candidate.item.id),
      temporalAnchorDensity: candidate.temporalAnchorDensity,
      semanticScore: candidate.semanticScore,
      recencyScore: candidate.recencyScore,
      slotCoverage: candidate.slotCoverage,
      slotMatches: candidate.slotMatches,
      finalScore: candidate.finalScore,
      rationale: buildTemporalRecoveryRationale(candidate.slotCoverage, candidate.temporalAnchorDensity, candidate.semanticScore),
    }));

  return { ranked, debug, temporalQuery, slots };
}

export function resetTemporalCachesForTest(): void {
  temporalAnchorCache.clear();
}

function extractTemporalSlots(text: string): string[] {
  const clauses = text
    .split(/(?:\bafter\b|\bbefore\b|\bbetween\b|\bor\b|\band\b|\bthen\b|[?.!,;]+)/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const slots = new Set<string>();

  for (const clause of clauses) {
    const terms = normalizeTerms(clause)
      .filter((term) => term.length >= 3 && !TEMPORAL_SLOT_STOPWORDS.has(term));
    if (terms.length === 0) {
      continue;
    }
    if (terms.length <= 3) {
      slots.add(terms.join(" "));
      continue;
    }
    slots.add(terms.slice(0, 4).join(" "));
    slots.add(terms.slice(-4).join(" "));
  }

  if (slots.size === 0) {
    const fallback = normalizeTerms(text).filter((term) => term.length >= 3 && !TEMPORAL_SLOT_STOPWORDS.has(term));
    if (fallback.length > 0) {
      slots.add(fallback.slice(0, 4).join(" "));
    }
  }

  return [...slots].slice(0, 4);
}

function computeSlotCoverage(slots: string[], candidateText: string): { coverage: number; matches: string[] } {
  if (slots.length === 0) {
    return { coverage: 0, matches: [] };
  }

  const candidateTerms = new Set(normalizeTerms(candidateText));
  const matches: string[] = [];
  let covered = 0;

  for (const slot of slots) {
    const slotTerms = normalizeTerms(slot).filter((term) => term.length >= 3);
    if (slotTerms.length === 0) {
      continue;
    }
    const overlap = slotTerms.filter((term) => candidateTerms.has(term)).length / slotTerms.length;
    if (overlap >= 0.5) {
      covered += 1;
      matches.push(slot);
    }
  }

  return {
    coverage: covered / Math.max(1, slots.length),
    matches,
  };
}

function buildTemporalRecoveryRationale(slotCoverage: number, anchorDensity: number, semanticScore: number): string {
  if (slotCoverage >= 0.5 && anchorDensity >= 0.5) {
    return "slot coverage and temporal anchors both supported this candidate";
  }
  if (slotCoverage >= 0.5) {
    return "slot coverage lifted this candidate toward the query's subevents";
  }
  if (anchorDensity >= 0.5) {
    return "temporal anchors lifted this candidate toward the query's date logic";
  }
  if (semanticScore >= 0.6) {
    return "semantic similarity kept this candidate in the temporal pool";
  }
  return "candidate remained in the bounded temporal recovery pool";
}

function computeRecencyScore(item: SearchResult, now: number, recencyLambda: number): number {
  const ts = typeof item.metadata.ts === "number" ? item.metadata.ts : now;
  const ageSeconds = Math.max(0, now - ts) / 1000;
  return Math.exp(-recencyLambda * ageSeconds);
}

function normalizeTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((term) => term.length > 0);
}

function touchTemporalAnchorCache(cacheKey: string, value: number): void {
  if (temporalAnchorCache.has(cacheKey)) {
    temporalAnchorCache.delete(cacheKey);
  }
  temporalAnchorCache.set(cacheKey, value);
  if (temporalAnchorCache.size > TEMPORAL_ANCHOR_CACHE_MAX) {
    const oldestKey = temporalAnchorCache.keys().next().value;
    if (typeof oldestKey === "string") {
      temporalAnchorCache.delete(oldestKey);
    }
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
