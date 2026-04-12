import assert from "node:assert/strict";
import test from "node:test";

import { COMPARISON_ABLATION_MODES, resolveComparisonExperimentConfig } from "../../src/comparison-experiments.js";
import { rankTemporalRecoveryCandidates, resetTemporalCachesForTest } from "../../src/temporal.js";

test("resolveComparisonExperimentConfig defaults to profiling off with no ablation", () => {
  const config = resolveComparisonExperimentConfig({});
  assert.equal(config.profilingEnabled, false);
  assert.equal(config.ablationMode, null);
  assert.equal(config.disableReserveBump, false);
  assert.equal(config.disableProtectedPairPack, false);
  assert.equal(config.disableDiscriminativeAffiliation, false);
  assert.equal(config.disableWitnessPositionPastness, false);
  assert.equal(config.disableContaminationPenalty, false);
  assert.equal(config.disablePairScoreOnWitness, false);
  assert.equal(config.disableComparisonBlend, false);
});

test("resolveComparisonExperimentConfig enables exactly one ablation family per mode", () => {
  for (const mode of COMPARISON_ABLATION_MODES) {
    const config = resolveComparisonExperimentConfig({
      LONGMEMEVAL_PROFILE_COMPARISON: "1",
      LONGMEMEVAL_COMPARISON_PROFILE_MODE: mode,
    });
    assert.equal(config.profilingEnabled, true);
    assert.equal(config.ablationMode, mode);
    const enabledFlags = [
      config.disableReserveBump,
      config.disableProtectedPairPack,
      config.disableDiscriminativeAffiliation,
      config.disableWitnessPositionPastness,
      config.disableContaminationPenalty,
      config.disablePairScoreOnWitness,
      config.disableComparisonBlend,
    ].filter(Boolean);
    assert.equal(enabledFlags.length, 1, `expected exactly one ablation flag for mode ${mode}`);
  }
});

test("comparison profiling emits a summary without changing ranking behavior", () => {
  resetTemporalCachesForTest();
  const now = Date.now();
  const items = [
    {
      id: "europe",
      score: 0.72,
      text: "I went on a two-week trip to Europe with my parents and younger brother.",
      metadata: { ts: now - 10_000, userId: "u1", collection: "turns:u1" },
    },
    {
      id: "thailand",
      score: 0.68,
      text: "I was just sharing my own experience of traveling solo in Thailand last year.",
      metadata: { ts: now - 5_000, userId: "u1", collection: "turns:u1" },
    },
  ];
  const queryText = "Which trip did I take first, the one to Europe with family or the solo trip to Thailand?";
  const previousProfileFlag = process.env.LONGMEMEVAL_PROFILE_COMPARISON;
  const previousMode = process.env.LONGMEMEVAL_COMPARISON_PROFILE_MODE;

  try {
    delete process.env.LONGMEMEVAL_PROFILE_COMPARISON;
    delete process.env.LONGMEMEVAL_COMPARISON_PROFILE_MODE;
    const baseline = rankTemporalRecoveryCandidates(items, { queryText, nowMs: now, maxSelected: 2 });

    process.env.LONGMEMEVAL_PROFILE_COMPARISON = "1";
    const profiled = rankTemporalRecoveryCandidates(items, { queryText, nowMs: now, maxSelected: 2 });

    assert.equal(baseline.comparisonProfile, undefined);
    assert.ok(profiled.comparisonProfile);
    assert.deepEqual(
      profiled.ranked.map((item) => ({ id: item.id, finalScore: item.finalScore })),
      baseline.ranked.map((item) => ({ id: item.id, finalScore: item.finalScore })),
    );
    assert.ok((profiled.comparisonProfile?.rawCandidateCount ?? 0) >= 2);
    assert.ok((profiled.comparisonProfile?.estimateTokensCalls ?? 0) >= 2);
  } finally {
    if (typeof previousProfileFlag === "string") {
      process.env.LONGMEMEVAL_PROFILE_COMPARISON = previousProfileFlag;
    } else {
      delete process.env.LONGMEMEVAL_PROFILE_COMPARISON;
    }
    if (typeof previousMode === "string") {
      process.env.LONGMEMEVAL_COMPARISON_PROFILE_MODE = previousMode;
    } else {
      delete process.env.LONGMEMEVAL_COMPARISON_PROFILE_MODE;
    }
  }
});
