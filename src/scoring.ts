import type { SearchResult } from "./types.js";

interface HybridOptions {
  alpha?: number;
  beta?: number;
  gamma?: number;
  delta?: number;
  recencyLambdaSession?: number;
  recencyLambdaUser?: number;
  recencyLambdaGlobal?: number;
  sessionId: string;
  userId: string;
}

interface Section7Options {
  queryText: string;
  sessionId: string;
  userId: string;
  k1?: number;
  k2?: number;
  theta1?: number;
  kappa?: number;
  authorityRecencyLambda?: number;
  authorityRecencyWeight?: number;
  authorityFrequencyWeight?: number;
  authorityAuthoredWeight?: number;
  nowMs?: number;
}

interface HopOptions {
  etaHop?: number;
  thetaHop?: number;
}

interface RawUserRecoveryOptions {
  queryText: string;
  nowMs?: number;
  recencyLambda?: number;
}

export interface RawUserRecoveryDebugCandidate {
  id: string;
  text: string;
  semanticScore: number;
  lexicalCoverage: number;
  recencyScore: number;
  finalScore: number;
  rationale: string;
}

interface ExpansionOptions {
  confidenceThreshold?: number;
  maxDepth?: number;
  tokenBudget?: number;
  penaltyFactor?: number;
}

export interface RecoveryTriggerResult {
  signal1CascadeTier3: boolean;
  signal2TopScoreBelowFloor: boolean;
  signal3AllSummariesLowConfidence: boolean;
  fire: boolean;
}

interface RetrievalFailureOptions {
  floorScore?: number;
  minTopK?: number;
  meanConfidenceThresh?: number;
}

export function detectRetrievalFailure(
  ranked: SearchResult[],
  opts: RetrievalFailureOptions = {},
): RecoveryTriggerResult {
  if (ranked.length === 0) {
    return {
      signal1CascadeTier3: false,
      signal2TopScoreBelowFloor: false,
      signal3AllSummariesLowConfidence: false,
      fire: false,
    };
  }
  const floorScore = opts.floorScore ?? 0.15;
  const minTopK = Math.max(1, Math.floor(opts.minTopK ?? 4));
  const meanConfidenceThresh = clamp01(opts.meanConfidenceThresh ?? 0.5);

  // Signal 1: cascade exhaustion (cascade_tier === 3 present)
  const signal1CascadeTier3 = ranked.some(
    (item) => item.metadata.cascade_tier === 3,
  );

  // Signal 2: top score below floor
  const topScore = ranked[0]!.finalScore ?? 0;
  const signal2TopScoreBelowFloor = topScore < floorScore;

  // Signal 3: top-k items are all summaries with low mean confidence
  const topK = ranked.slice(0, Math.min(minTopK, ranked.length));
  const allSummaries = topK.length > 0 && topK.every((item) => item.metadata.type === "summary");
  const meanConfidence =
    allSummaries && topK.length > 0
      ? topK.reduce(
          (sum, item) => sum + (typeof item.metadata.confidence === "number" ? item.metadata.confidence : 0),
          0,
        ) / topK.length
      : NaN;
  const signal3AllSummariesLowConfidence =
    allSummaries && topK.length >= minTopK && meanConfidence < meanConfidenceThresh;

  // Composite: (S1 AND S2) OR S3
  const fire = (signal1CascadeTier3 && signal2TopScoreBelowFloor) || signal3AllSummariesLowConfidence;

  return {
    signal1CascadeTier3,
    signal2TopScoreBelowFloor,
    signal3AllSummariesLowConfidence,
    fire,
  };
}

export function expandSummaryCandidates(
  items: SearchResult[],
  expandFn: (sessionId: string, summaryId: string, maxDepth: number) => Promise<SearchResult[]>,
  sessionId: string,
  opts: ExpansionOptions,
): Promise<SearchResult[]> {
  const confidenceThreshold = opts.confidenceThreshold ?? 0.7;
  const maxDepth = opts.maxDepth ?? 2;
  const penaltyFactor = opts.penaltyFactor ?? 0.85;
  const tokenBudget = typeof opts.tokenBudget === "number" ? Math.max(0, opts.tokenBudget) : Number.POSITIVE_INFINITY;

  return (async () => {
    const out: SearchResult[] = [];
    let remainingBudget = tokenBudget;

    for (const summary of items) {
      const conf = typeof summary.metadata.confidence === "number" ? summary.metadata.confidence : 0;
      if (summary.metadata.type !== "summary" || conf < confidenceThreshold) {
        continue;
      }
      if (Number.isFinite(tokenBudget) && remainingBudget <= 0) {
        break;
      }

      const rawChildren = await expandFn(sessionId, summary.id, maxDepth);
      for (const child of rawChildren) {
        const cost = childTokenCost(child);
        if (!Number.isFinite(cost)) {
          continue;
        }
        if (Number.isFinite(tokenBudget) && cost > remainingBudget) {
          continue;
        }
        if (Number.isFinite(tokenBudget)) {
          remainingBudget -= cost;
        }
        out.push({
          ...child,
          metadata: {
            ...child.metadata,
            expanded_from_summary: true,
            parent_summary_id: summary.id,
            expansion_depth: (typeof summary.metadata.expansion_depth === "number" ? summary.metadata.expansion_depth : 0) + 1,
          },
          finalScore: clamp01((child.finalScore ?? child.score) * penaltyFactor),
        });
      }
    }

    return out;
  })();
}

export function mergeSection7VariantCandidates(
  ranked: SearchResult[],
  hopExpanded: SearchResult[],
): SearchResult[] {
  const byID = new Map<string, SearchResult>();
  for (const item of [...ranked, ...hopExpanded]) {
    const existing = byID.get(item.id);
    if (!existing || (item.finalScore ?? 0) > (existing.finalScore ?? 0)) {
      byID.set(item.id, item);
    }
  }
  return [...byID.values()].sort((left, right) => (right.finalScore ?? 0) - (left.finalScore ?? 0));
}

export function scoreCandidates(items: SearchResult[], opts: HybridOptions): SearchResult[] {
  const now = Date.now();
  const { alpha, beta, gamma } = normalizeWeights(
    opts.alpha ?? 0.7,
    opts.beta ?? 0.2,
    opts.gamma ?? 0.1,
  );
  const delta = clamp01(opts.delta ?? 0.5);
  // Lambda units are per-second decay constants.
  const recencyLambdaSession = Math.max(0, opts.recencyLambdaSession ?? 0.0001);
  const recencyLambdaUser = Math.max(0, opts.recencyLambdaUser ?? 0.00001);
  const recencyLambdaGlobal = Math.max(0, opts.recencyLambdaGlobal ?? 0.000002);

  return items
    .map((item) => {
      const ts = typeof item.metadata.ts === "number" ? item.metadata.ts : now;
      const lambda =
        item.metadata.sessionId === opts.sessionId ? recencyLambdaSession
          : item.metadata.userId === opts.userId ? recencyLambdaUser
            : recencyLambdaGlobal;
      const ageSeconds = Math.max(0, now - ts) / 1000;
      const recency = Math.exp(-lambda * ageSeconds);
      const scopeBoost =
        item.metadata.sessionId === opts.sessionId ? 1.0
          : item.metadata.userId === opts.userId ? 0.6
            : 0.3;
      const similarity = clamp01(item.score);
      const baseScore =
        alpha * similarity +
        beta * recency +
        gamma * scopeBoost;
      const rawDecayRate =
        typeof item.metadata.decay_rate === "number" ? item.metadata.decay_rate : 0.0;
      const decayRate = Math.min(1, Math.max(0, rawDecayRate));
      const quality =
        item.metadata.type === "summary"
          ? 1.0 - delta * decayRate
          : 1.0;
      const finalScore = clamp01(baseScore * quality);

      return {
        ...item,
        finalScore,
      };
    })
    .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
}

export function rankSection7VariantCandidates(items: SearchResult[], opts: Section7Options): SearchResult[] {
  const now = opts.nowMs ?? Date.now();
  const k1 = Math.max(1, Math.floor(opts.k1 ?? 16));
  const k2 = Math.max(1, Math.floor(opts.k2 ?? 8));
  const theta1 = clampSimilarity(opts.theta1 ?? 0.2);
  const kappa = Math.max(0, opts.kappa ?? 0.3);
  const { alpha: alphaR, beta: alphaF, gamma: alphaA } = normalizeWeights(
    opts.authorityRecencyWeight ?? 0.5,
    opts.authorityFrequencyWeight ?? 0.2,
    opts.authorityAuthoredWeight ?? 0.3,
  );
  const authorityRecencyLambda = Math.max(0, opts.authorityRecencyLambda ?? 0.00001);

  const deduped = dedupeCandidates(items);
  const coarseRaw = [...deduped]
    .sort((left, right) => similarity(right) - similarity(left))
    .slice(0, k1);
  const coarseFiltered = coarseRaw.filter((item) => similarity(item) >= theta1);
  const maxAccessCount = coarseFiltered.reduce((max, item) => Math.max(max, accessCount(item)), 0);
  const keywords = extractKeywords(opts.queryText);

  return coarseFiltered
    .map((item) => {
      const omega = authorityWeight(item, {
        now,
        authorityRecencyLambda,
        alphaR,
        alphaF,
        alphaA,
        maxAccessCount,
      });
      const sim = Math.max(similarity(item), 0);
      const keywordCoverage = normalizedKeywordCoverage(keywords, item.text);
      const finalScore = omega * sim * ((1 + kappa * keywordCoverage) / (1 + kappa));

      return {
        ...item,
        finalScore: clamp01(finalScore),
      };
    })
    .sort((left, right) => (right.finalScore ?? 0) - (left.finalScore ?? 0))
    .slice(0, Math.min(k2, coarseFiltered.length));
}

export function expandSection7HopCandidates(
  ranked: SearchResult[],
  authoredVariantRecords: SearchResult[],
  opts: HopOptions,
): SearchResult[] {
  const etaHop = clampOpenUnit(opts.etaHop ?? 0.5);
  const thetaHop = clamp01(opts.thetaHop ?? 0.15);
  const rankedIDs = new Set(ranked.map((item) => item.id));
  const authoredByID = new Map(authoredVariantRecords.map((item) => [item.id, item] as const));
  const bestScores = new Map<string, number>();

  for (const parent of ranked) {
    const parentScore = clamp01(parent.finalScore ?? 0);
    for (const targetID of hopTargets(parent)) {
      if (rankedIDs.has(targetID)) {
        continue;
      }
      if (!authoredByID.has(targetID)) {
        continue;
      }
      const candidateScore = etaHop * parentScore;
      if (candidateScore > (bestScores.get(targetID) ?? -1)) {
        bestScores.set(targetID, candidateScore);
      }
    }
  }

  return [...bestScores.entries()]
    .filter(([, score]) => score >= thetaHop)
    .map(([id, score]) => ({
      ...authoredByID.get(id)!,
      finalScore: score,
    }))
    .sort((left, right) => (right.finalScore ?? 0) - (left.finalScore ?? 0));
}

export function rankRawUserRecoveryCandidates(
  items: SearchResult[],
  opts: RawUserRecoveryOptions,
): { ranked: SearchResult[]; debug: RawUserRecoveryDebugCandidate[] } {
  const now = opts.nowMs ?? Date.now();
  const recencyLambda = Math.max(0, opts.recencyLambda ?? 0.00001);
  const keywords = extractKeywords(opts.queryText);

  const ranked = items
    .map((item) => {
      const semanticScore = clamp01(typeof item.score === "number" ? item.score : 0);
      const lexicalCoverage = normalizedKeywordCoverage(keywords, item.text);
      const recencyScore = computeRecencyScore(item, now, recencyLambda);
      const finalScore = clamp01((0.30 * semanticScore) + (0.60 * lexicalCoverage) + (0.10 * recencyScore));
      const rationale = buildRawUserRecoveryRationale({
        semanticScore,
        lexicalCoverage,
        recencyScore,
      });

      return {
        ranked: {
          ...item,
          finalScore,
        },
        debug: {
          id: item.id,
          text: item.text,
          semanticScore,
          lexicalCoverage,
          recencyScore,
          finalScore,
          rationale,
        },
      };
    })
    .sort((left, right) => {
      if (right.ranked.finalScore !== left.ranked.finalScore) {
        return (right.ranked.finalScore ?? 0) - (left.ranked.finalScore ?? 0);
      }
      if (right.debug.lexicalCoverage !== left.debug.lexicalCoverage) {
        return right.debug.lexicalCoverage - left.debug.lexicalCoverage;
      }
      if (right.debug.semanticScore !== left.debug.semanticScore) {
        return right.debug.semanticScore - left.debug.semanticScore;
      }
      return left.ranked.id.localeCompare(right.ranked.id);
    });

  return {
    ranked: ranked.map((entry) => entry.ranked),
    debug: ranked.map((entry) => entry.debug),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function childTokenCost(item: SearchResult): number {
  const estimate = item.metadata.token_estimate;
  if (typeof estimate === "number" && Number.isFinite(estimate) && estimate > 0) {
    return Math.max(1, Math.floor(estimate));
  }
  return Number.POSITIVE_INFINITY;
}

function clampSimilarity(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

function clampOpenUnit(value: number): number {
  return Math.min(0.999999, Math.max(0.000001, value));
}

function normalizeWeights(alpha: number, beta: number, gamma: number): { alpha: number; beta: number; gamma: number } {
  alpha = clamp01(alpha);
  beta = clamp01(beta);
  gamma = clamp01(gamma);

  const sum = alpha + beta + gamma;
  if (sum <= 0) {
    return { alpha: 0.7, beta: 0.2, gamma: 0.1 };
  }

  return {
    alpha: alpha / sum,
    beta: beta / sum,
    gamma: gamma / sum,
  };
}

function dedupeCandidates(items: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const item of items) {
    const key = `${typeof item.metadata.collection === "string" ? item.metadata.collection : ""}::${item.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out;
}

function similarity(item: SearchResult): number {
  return clampSimilarity(typeof item.score === "number" ? item.score : 0);
}

function accessCount(item: SearchResult): number {
  const raw = item.metadata.access_count;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function authorityWeight(
  item: SearchResult,
  opts: {
    now: number;
    authorityRecencyLambda: number;
    alphaR: number;
    alphaF: number;
    alphaA: number;
    maxAccessCount: number;
  },
): number {
  const ts = typeof item.metadata.ts === "number" ? item.metadata.ts : opts.now;
  const ageSeconds = Math.max(0, opts.now - ts) / 1000;
  const recency = Math.exp(-opts.authorityRecencyLambda * ageSeconds);
  const frequency = normalizedFrequency(accessCount(item), opts.maxAccessCount);
  const authoredAuthority = clamp01(
    typeof item.metadata.authority === "number"
      ? item.metadata.authority
      : item.metadata.authored === true
        ? 1
        : 0,
  );
  return clamp01(
    opts.alphaR * recency +
      opts.alphaF * frequency +
      opts.alphaA * authoredAuthority,
  );
}

function normalizedFrequency(accessCount: number, maxAccessCount: number): number {
  if (accessCount <= 0 || maxAccessCount <= 0) {
    return 0;
  }
  return Math.log(1 + accessCount) / Math.log(1 + maxAccessCount + 1);
}

function computeRecencyScore(item: SearchResult, now: number, recencyLambda: number): number {
  const ts = typeof item.metadata.ts === "number" ? item.metadata.ts : now;
  const ageSeconds = Math.max(0, now - ts) / 1000;
  return Math.exp(-recencyLambda * ageSeconds);
}

function buildRawUserRecoveryRationale(scores: {
  semanticScore: number;
  lexicalCoverage: number;
  recencyScore: number;
}): string {
  const lexicalDelta = scores.lexicalCoverage - scores.semanticScore;
  if (lexicalDelta > 0.15) {
    return "lexical coverage lifted this candidate above its semantic score";
  }
  if (lexicalDelta < -0.15) {
    return "semantic similarity carried this candidate despite weaker lexical coverage";
  }
  if (scores.recencyScore > 0.9) {
    return "semantic and lexical scores were close; recency broke the tie";
  }
  return "semantic and lexical scores were balanced";
}

function extractKeywords(text: string): string[] {
  const tokens = normalizeTerms(text);
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const token of tokens) {
    if (token.length < 3 || seen.has(token)) {
      continue;
    }
    seen.add(token);
    keywords.push(token);
  }
  return keywords;
}

function normalizedKeywordCoverage(keywords: string[], text: string): number {
  if (keywords.length === 0) {
    return 0;
  }
  const docTerms = new Set(normalizeTerms(text));
  let matches = 0;
  for (const keyword of keywords) {
    if (docTerms.has(keyword)) {
      matches += 1;
    }
  }
  return matches / Math.max(keywords.length, 1);
}

function normalizeTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((term) => term.length > 0);
}

function hopTargets(item: SearchResult): string[] {
  const raw = item.metadata.hop_targets;
  if (Array.isArray(raw)) {
    return raw.filter((target): target is string => typeof target === "string" && target.length > 0);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  return [];
}
