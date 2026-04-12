export const COMPARISON_ABLATION_MODES = [
  "reserve_bump",
  "protected_pair_pack",
  "discriminative_affiliation",
  "witness_position_pastness",
  "contamination_penalty",
  "pair_score_on_witness",
  "comparison_blend",
] as const;

export type ComparisonAblationMode = typeof COMPARISON_ABLATION_MODES[number];

export interface ComparisonProfileSummary {
  ablationMode?: ComparisonAblationMode;
  rankTotalMs: number;
  decorateMs: number;
  slotCoverageMs: number;
  sideAffiliationMs: number;
  specificityMs: number;
  pairSelectionMs: number;
  greedyFillMs: number;
  recoveryPackingMs: number;
  debugBuildMs: number;
  rawCandidateCount: number;
  comparisonCandidateCount: number;
  side0AffiliatedCount: number;
  side1AffiliatedCount: number;
  normalizeTermsCalls: number;
  normalizeContentTermsCalls: number;
  estimateTokensCalls: number;
  sortCalls: number;
  totalSortedLength: number;
}

export interface ComparisonExperimentConfig {
  profilingEnabled: boolean;
  ablationMode: ComparisonAblationMode | null;
  disableReserveBump: boolean;
  disableProtectedPairPack: boolean;
  disableDiscriminativeAffiliation: boolean;
  disableWitnessPositionPastness: boolean;
  disableContaminationPenalty: boolean;
  disablePairScoreOnWitness: boolean;
  disableComparisonBlend: boolean;
}

export function resolveComparisonExperimentConfig(
  env: NodeJS.ProcessEnv = process.env,
): ComparisonExperimentConfig {
  const profilingEnabled = env.LONGMEMEVAL_PROFILE_COMPARISON === "1";
  const rawMode = env.LONGMEMEVAL_COMPARISON_PROFILE_MODE?.trim() ?? "";
  const ablationMode = COMPARISON_ABLATION_MODES.includes(rawMode as ComparisonAblationMode)
    ? rawMode as ComparisonAblationMode
    : null;
  return {
    profilingEnabled,
    ablationMode,
    disableReserveBump: ablationMode === "reserve_bump",
    disableProtectedPairPack: ablationMode === "protected_pair_pack",
    disableDiscriminativeAffiliation: ablationMode === "discriminative_affiliation",
    disableWitnessPositionPastness: ablationMode === "witness_position_pastness",
    disableContaminationPenalty: ablationMode === "contamination_penalty",
    disablePairScoreOnWitness: ablationMode === "pair_score_on_witness",
    disableComparisonBlend: ablationMode === "comparison_blend",
  };
}

export function createComparisonProfileSummary(
  ablationMode: ComparisonAblationMode | null,
): ComparisonProfileSummary {
  return {
    ablationMode: ablationMode ?? undefined,
    rankTotalMs: 0,
    decorateMs: 0,
    slotCoverageMs: 0,
    sideAffiliationMs: 0,
    specificityMs: 0,
    pairSelectionMs: 0,
    greedyFillMs: 0,
    recoveryPackingMs: 0,
    debugBuildMs: 0,
    rawCandidateCount: 0,
    comparisonCandidateCount: 0,
    side0AffiliatedCount: 0,
    side1AffiliatedCount: 0,
    normalizeTermsCalls: 0,
    normalizeContentTermsCalls: 0,
    estimateTokensCalls: 0,
    sortCalls: 0,
    totalSortedLength: 0,
  };
}

export function mergeComparisonProfileSummaries(
  profiles: ComparisonProfileSummary[],
): ComparisonProfileSummary | null {
  if (profiles.length === 0) {
    return null;
  }

  const merged = createComparisonProfileSummary(
    profiles.every((profile) => profile.ablationMode === profiles[0]!.ablationMode)
      ? (profiles[0]!.ablationMode ?? null)
      : null,
  );
  for (const profile of profiles) {
    merged.rankTotalMs += profile.rankTotalMs;
    merged.decorateMs += profile.decorateMs;
    merged.slotCoverageMs += profile.slotCoverageMs;
    merged.sideAffiliationMs += profile.sideAffiliationMs;
    merged.specificityMs += profile.specificityMs;
    merged.pairSelectionMs += profile.pairSelectionMs;
    merged.greedyFillMs += profile.greedyFillMs;
    merged.recoveryPackingMs += profile.recoveryPackingMs;
    merged.debugBuildMs += profile.debugBuildMs;
    merged.rawCandidateCount += profile.rawCandidateCount;
    merged.comparisonCandidateCount += profile.comparisonCandidateCount;
    merged.side0AffiliatedCount += profile.side0AffiliatedCount;
    merged.side1AffiliatedCount += profile.side1AffiliatedCount;
    merged.normalizeTermsCalls += profile.normalizeTermsCalls;
    merged.normalizeContentTermsCalls += profile.normalizeContentTermsCalls;
    merged.estimateTokensCalls += profile.estimateTokensCalls;
    merged.sortCalls += profile.sortCalls;
    merged.totalSortedLength += profile.totalSortedLength;
  }

  return merged;
}
