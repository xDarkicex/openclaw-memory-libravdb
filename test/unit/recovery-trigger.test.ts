import test from "node:test";
import assert from "node:assert/strict";

import { detectRetrievalFailure } from "../../src/scoring.js";
import type { SearchResult } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Signal 2 — ranked top score below floor
// ---------------------------------------------------------------------------

test("detectRetrievalFailure: signal2 fires when top score is below 0.15 floor", () => {
  const ranked: SearchResult[] = [
    { id: "a", score: 0, text: "a", metadata: {}, finalScore: 0.08 },
    { id: "b", score: 0, text: "b", metadata: {}, finalScore: 0.42 },
  ];

  const result = detectRetrievalFailure(ranked, { floorScore: 0.15 });

  assert.equal(result.signal2TopScoreBelowFloor, true);
  assert.equal(result.fire, false); // no cascade tier 3, no signal3
});

test("detectRetrievalFailure: signal2 does not fire when top score is above floor", () => {
  const ranked: SearchResult[] = [
    { id: "a", score: 0, text: "a", metadata: {}, finalScore: 0.45 },
    { id: "b", score: 0, text: "b", metadata: {}, finalScore: 0.20 },
  ];

  const result = detectRetrievalFailure(ranked, { floorScore: 0.15 });

  assert.equal(result.signal2TopScoreBelowFloor, false);
  assert.equal(result.fire, false);
});

test("detectRetrievalFailure: signal2 is false when ranked list is empty", () => {
  const result = detectRetrievalFailure([], { floorScore: 0.15 });
  assert.equal(result.signal2TopScoreBelowFloor, false);
  assert.equal(result.fire, false);
});

// ---------------------------------------------------------------------------
// Signal 3 — top-k all low-confidence summaries
// ---------------------------------------------------------------------------

test("detectRetrievalFailure: signal3 fires when all top-4 are low-confidence summaries", () => {
  const ranked: SearchResult[] = [
    { id: "a", score: 0, text: "a", metadata: { type: "summary", confidence: 0.30 }, finalScore: 0.80 },
    { id: "b", score: 0, text: "b", metadata: { type: "summary", confidence: 0.42 }, finalScore: 0.60 },
    { id: "c", score: 0, text: "c", metadata: { type: "summary", confidence: 0.25 }, finalScore: 0.50 },
    { id: "d", score: 0, text: "d", metadata: { type: "summary", confidence: 0.38 }, finalScore: 0.40 },
  ];

  const result = detectRetrievalFailure(ranked, { minTopK: 4, meanConfidenceThresh: 0.5 });

  assert.equal(result.signal3AllSummariesLowConfidence, true);
  assert.equal(result.fire, true); // signal3 alone is sufficient
});

test("detectRetrievalFailure: signal3 does not fire when top-4 mix raw and summary", () => {
  const ranked: SearchResult[] = [
    { id: "a", score: 0, text: "a", metadata: { type: "summary", confidence: 0.30 }, finalScore: 0.80 },
    { id: "b", score: 0, text: "b", metadata: { type: "summary", confidence: 0.42 }, finalScore: 0.60 },
    { id: "c", score: 0, text: "c", metadata: { type: "turn" }, finalScore: 0.55 },
    { id: "d", score: 0, text: "d", metadata: { type: "summary", confidence: 0.25 }, finalScore: 0.40 },
  ];

  const result = detectRetrievalFailure(ranked, { minTopK: 4, meanConfidenceThresh: 0.5 });

  assert.equal(result.signal3AllSummariesLowConfidence, false);
  assert.equal(result.fire, false);
});

test("detectRetrievalFailure: signal3 does not fire when summaries have mean confidence >= 0.5", () => {
  const ranked: SearchResult[] = [
    { id: "a", score: 0, text: "a", metadata: { type: "summary", confidence: 0.55 }, finalScore: 0.80 },
    { id: "b", score: 0, text: "b", metadata: { type: "summary", confidence: 0.65 }, finalScore: 0.60 },
    { id: "c", score: 0, text: "c", metadata: { type: "summary", confidence: 0.50 }, finalScore: 0.50 },
    { id: "d", score: 0, text: "d", metadata: { type: "summary", confidence: 0.60 }, finalScore: 0.40 },
  ];

  const result = detectRetrievalFailure(ranked, { minTopK: 4, meanConfidenceThresh: 0.5 });

  assert.equal(result.signal3AllSummariesLowConfidence, false);
  assert.equal(result.fire, false);
});

test("detectRetrievalFailure: signal3 is false when ranked has fewer than minTopK items", () => {
  const ranked: SearchResult[] = [
    { id: "a", score: 0, text: "a", metadata: { type: "summary", confidence: 0.30 }, finalScore: 0.80 },
    { id: "b", score: 0, text: "b", metadata: { type: "summary", confidence: 0.42 }, finalScore: 0.60 },
  ];

  // ranked.length(2) < minTopK(4), so allSummaries check is false
  const result = detectRetrievalFailure(ranked, { minTopK: 4, meanConfidenceThresh: 0.5 });
  assert.equal(result.signal3AllSummariesLowConfidence, false);
  assert.equal(result.fire, false);
});

test("detectRetrievalFailure: signal3 uses actual ranked length when it exceeds default minTopK", () => {
  // 6 items, all summaries, mean conf = 0.30 < 0.5 — should fire
  const ranked: SearchResult[] = [
    { id: "a", score: 0, text: "a", metadata: { type: "summary", confidence: 0.30 }, finalScore: 0.80 },
    { id: "b", score: 0, text: "b", metadata: { type: "summary", confidence: 0.35 }, finalScore: 0.60 },
    { id: "c", score: 0, text: "c", metadata: { type: "summary", confidence: 0.25 }, finalScore: 0.50 },
    { id: "d", score: 0, text: "d", metadata: { type: "summary", confidence: 0.32 }, finalScore: 0.40 },
    { id: "e", score: 0, text: "e", metadata: { type: "summary", confidence: 0.28 }, finalScore: 0.35 },
    { id: "f", score: 0, text: "f", metadata: { type: "summary", confidence: 0.30 }, finalScore: 0.30 },
  ];

  const result = detectRetrievalFailure(ranked, { meanConfidenceThresh: 0.5 });

  assert.equal(result.signal3AllSummariesLowConfidence, true);
  assert.equal(result.fire, true);
});

// ---------------------------------------------------------------------------
// Signal 1 — cascade tier exhaustion (cascade_tier === 3)
// ---------------------------------------------------------------------------

test("detectRetrievalFailure: signal1 is true when cascade_tier=3 is present", () => {
  const ranked: SearchResult[] = [
    { id: "a", score: 0, text: "a", metadata: { cascade_tier: 3 }, finalScore: 0.10 },
    { id: "b", score: 0, text: "b", metadata: { cascade_tier: 2 }, finalScore: 0.08 },
  ];

  const result = detectRetrievalFailure(ranked, { floorScore: 0.15 });

  assert.equal(result.signal1CascadeTier3, true);
  // S2 also true (top=0.10 < 0.15), so composite fires via S1 AND S2
  assert.equal(result.fire, true);
});

test("detectRetrievalFailure: signal1 is false when no cascade_tier=3 is present", () => {
  const ranked: SearchResult[] = [
    { id: "a", score: 0, text: "a", metadata: { cascade_tier: 1 }, finalScore: 0.80 },
    { id: "b", score: 0, text: "b", metadata: { cascade_tier: 2 }, finalScore: 0.60 },
  ];

  const result = detectRetrievalFailure(ranked, { floorScore: 0.15 });

  assert.equal(result.signal1CascadeTier3, false);
});

test("detectRetrievalFailure: signal1 is false when cascade_tier metadata is absent", () => {
  const ranked: SearchResult[] = [
    { id: "a", score: 0, text: "a", metadata: {}, finalScore: 0.08 },
  ];

  const result = detectRetrievalFailure(ranked, { floorScore: 0.15 });

  assert.equal(result.signal1CascadeTier3, false);
});

// ---------------------------------------------------------------------------
// Composite rule — (Signal1 AND Signal2) OR Signal3
// ---------------------------------------------------------------------------

test("detectRetrievalFailure: composite fires via S3 alone", () => {
  // S3 fires (all summaries, mean conf < 0.5), S1 and S2 are false
  const ranked: SearchResult[] = [
    { id: "a", score: 0, text: "a", metadata: { type: "summary", confidence: 0.10 }, finalScore: 0.80 },
    { id: "b", score: 0, text: "b", metadata: { type: "summary", confidence: 0.12 }, finalScore: 0.60 },
    { id: "c", score: 0, text: "c", metadata: { type: "summary", confidence: 0.11 }, finalScore: 0.50 },
    { id: "d", score: 0, text: "d", metadata: { type: "summary", confidence: 0.09 }, finalScore: 0.40 },
  ];

  const result = detectRetrievalFailure(ranked, { floorScore: 0.15, meanConfidenceThresh: 0.5 });

  assert.equal(result.fire, true);
  assert.equal(result.signal3AllSummariesLowConfidence, true);
  assert.equal(result.signal1CascadeTier3, false);
  assert.equal(result.signal2TopScoreBelowFloor, false);
});

test("detectRetrievalFailure: composite fires via S1 AND S2 (cascade exhaustion + weak ranking)", () => {
  // cascade tier 3 (S1=true) AND top score 0.08 < 0.15 (S2=true)
  const ranked: SearchResult[] = [
    { id: "a", score: 0, text: "a", metadata: { cascade_tier: 3 }, finalScore: 0.08 },
    { id: "b", score: 0, text: "b", metadata: { cascade_tier: 2 }, finalScore: 0.05 },
  ];

  const result = detectRetrievalFailure(ranked, { floorScore: 0.15 });

  assert.equal(result.fire, true);
  assert.equal(result.signal1CascadeTier3, true);
  assert.equal(result.signal2TopScoreBelowFloor, true);
  assert.equal(result.signal3AllSummariesLowConfidence, false);
});

test("detectRetrievalFailure: composite does NOT fire when only S1 is true", () => {
  // cascade exhausted (S1=true) but top score is strong (S2=false) — S3 also false
  const ranked: SearchResult[] = [
    { id: "a", score: 0, text: "a", metadata: { cascade_tier: 3 }, finalScore: 0.80 },
    { id: "b", score: 0, text: "b", metadata: { cascade_tier: 2 }, finalScore: 0.60 },
  ];

  const result = detectRetrievalFailure(ranked, { floorScore: 0.15 });

  assert.equal(result.fire, false);
  assert.equal(result.signal1CascadeTier3, true);
  assert.equal(result.signal2TopScoreBelowFloor, false);
});

test("detectRetrievalFailure: composite does NOT fire when only S2 is true", () => {
  // top score below floor (S2=true) but no cascade exhaustion (S1=false)
  // S3 also false
  const ranked: SearchResult[] = [
    { id: "a", score: 0, text: "a", metadata: { cascade_tier: 1 }, finalScore: 0.08 },
    { id: "b", score: 0, text: "b", metadata: { cascade_tier: 1 }, finalScore: 0.05 },
  ];

  const result = detectRetrievalFailure(ranked, { floorScore: 0.15 });

  assert.equal(result.fire, false);
  assert.equal(result.signal1CascadeTier3, false);
  assert.equal(result.signal2TopScoreBelowFloor, true);
});

test("detectRetrievalFailure: composite does NOT fire on healthy session (all signals false)", () => {
  const ranked: SearchResult[] = [
    { id: "a", score: 0, text: "a", metadata: { cascade_tier: 1, type: "turn" }, finalScore: 0.82 },
    { id: "b", score: 0, text: "b", metadata: { cascade_tier: 1, type: "summary", confidence: 0.80 }, finalScore: 0.75 },
    { id: "c", score: 0, text: "c", metadata: { cascade_tier: 2, type: "turn" }, finalScore: 0.65 },
    { id: "d", score: 0, text: "d", metadata: { cascade_tier: 2, type: "summary", confidence: 0.72 }, finalScore: 0.55 },
  ];

  const result = detectRetrievalFailure(ranked, { floorScore: 0.15, meanConfidenceThresh: 0.5 });

  assert.equal(result.signal1CascadeTier3, false);
  assert.equal(result.signal2TopScoreBelowFloor, false);
  assert.equal(result.signal3AllSummariesLowConfidence, false);
  assert.equal(result.fire, false);
});

test("detectRetrievalFailure: composite is false when ranked is empty", () => {
  const result = detectRetrievalFailure([], { floorScore: 0.15 });
  assert.equal(result.fire, false);
});

// ---------------------------------------------------------------------------
// Policy boundary — fire is a diagnostic signal, not a mutation
// ---------------------------------------------------------------------------

test("detectRetrievalFailure: fire=true is a diagnostic signal, not a mutation of input", () => {
  const ranked: SearchResult[] = [
    { id: "a", score: 0, text: "a", metadata: { type: "summary", confidence: 0.10 }, finalScore: 0.80 },
    { id: "b", score: 0, text: "b", metadata: { type: "summary", confidence: 0.12 }, finalScore: 0.60 },
    { id: "c", score: 0, text: "c", metadata: { type: "summary", confidence: 0.11 }, finalScore: 0.50 },
    { id: "d", score: 0, text: "d", metadata: { type: "summary", confidence: 0.09 }, finalScore: 0.40 },
  ];

  const result = detectRetrievalFailure(ranked, { meanConfidenceThresh: 0.5 });

  assert.equal(result.fire, true);
  // Input ranked array is not mutated
  assert.equal(ranked[0].finalScore, 0.80);
  assert.equal(ranked[0].metadata.type, "summary");
});
