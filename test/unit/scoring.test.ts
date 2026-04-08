import test from "node:test";
import assert from "node:assert/strict";

import {
  expandSummaryCandidates,
  expandSection7HopCandidates,
  mergeSection7VariantCandidates,
  rankRawUserRecoveryCandidates,
  rankSection7VariantCandidates,
  scoreCandidates,
} from "../../src/scoring.js";
import type { SearchResult } from "../../src/types.js";

test("scoreCandidates orders by combined weighting", () => {
  const now = Date.now();
  const hits: SearchResult[] = [
    {
      id: "session-hit",
      score: 0.6,
      text: "session",
      metadata: { ts: now, sessionId: "s1" },
    },
    {
      id: "global-hit",
      score: 0.95,
      text: "global",
      metadata: { ts: now - 10_000, source: "spec" },
    },
  ];

  const ranked = scoreCandidates(hits, {
    alpha: 0.7,
    beta: 0.2,
    gamma: 0.1,
    recencyLambdaSession: 0.0001,
    recencyLambdaUser: 0.00001,
    recencyLambdaGlobal: 0.000002,
    sessionId: "s1",
    userId: "u1",
  });

  assert.equal(ranked[0]?.id, "global-hit");
  assert.ok((ranked[0]?.finalScore ?? 0) >= (ranked[1]?.finalScore ?? 0));
});

test("scoreCandidates handles empty input", () => {
  assert.deepEqual(
    scoreCandidates([], {
      sessionId: "s1",
      userId: "u1",
    }),
    [],
  );
});

test("summary decay_rate lowers retrieval score relative to higher-quality summaries and raw turns", () => {
  const now = Date.now();
  const hits: SearchResult[] = [
    {
      id: "high-confidence-summary",
      score: 0.9,
      text: "high confidence summary",
      metadata: { type: "summary", decay_rate: 0.1, ts: now, sessionId: "s1" },
    },
    {
      id: "low-confidence-summary",
      score: 0.9,
      text: "low confidence summary",
      metadata: { type: "summary", decay_rate: 0.9, ts: now, sessionId: "s1" },
    },
    {
      id: "raw-turn",
      score: 0.9,
      text: "raw turn",
      metadata: { type: "turn", ts: now, sessionId: "s1" },
    },
  ];

  const ranked = scoreCandidates(hits, {
    alpha: 0.7,
    beta: 0.2,
    gamma: 0.1,
    delta: 0.5,
    recencyLambdaSession: 0.0001,
    recencyLambdaUser: 0.00001,
    recencyLambdaGlobal: 0.000002,
    sessionId: "s1",
    userId: "u1",
  });

  assert.equal(ranked[0]?.id, "raw-turn");
  assert.equal(ranked[1]?.id, "high-confidence-summary");
  assert.equal(ranked[2]?.id, "low-confidence-summary");
  assert.ok((ranked[1]?.finalScore ?? 0) > (ranked[2]?.finalScore ?? 0));
});

test("summary quality multiplier matches Q(s) = 1 - delta * decay_rate exactly under equal base score", () => {
  const now = Date.now();
  const ranked = scoreCandidates([
    {
      id: "summary-hit",
      score: 1,
      text: "summary hit",
      metadata: { type: "summary", decay_rate: 0.2, ts: now, sessionId: "s1" },
    },
  ], {
    alpha: 1,
    beta: 0,
    gamma: 0,
    delta: 0.5,
    sessionId: "s1",
    userId: "u1",
  });

  assert.equal(ranked[0]?.finalScore, 0.9);
});

test("section 6 downstream composition preserves confidence ordering under equal base score", () => {
  const now = Date.now();
  const baseScore = 0.8;
  const delta = 0.5;
  const highConfidence = 0.82;
  const lowConfidence = 0.34;

  const ranked = scoreCandidates([
    {
      id: "high-confidence-summary",
      score: baseScore,
      text: "high confidence summary",
      metadata: { type: "summary", decay_rate: 1 - highConfidence, ts: now, sessionId: "s1" },
    },
    {
      id: "low-confidence-summary",
      score: baseScore,
      text: "low confidence summary",
      metadata: { type: "summary", decay_rate: 1 - lowConfidence, ts: now, sessionId: "s1" },
    },
  ], {
    alpha: 1,
    beta: 0,
    gamma: 0,
    delta,
    sessionId: "s1",
    userId: "u1",
  });

  const expectedHigh = baseScore * (1 - delta * (1 - highConfidence));
  const expectedLow = baseScore * (1 - delta * (1 - lowConfidence));

  assert.equal(ranked[0]?.id, "high-confidence-summary");
  assert.equal(ranked[1]?.id, "low-confidence-summary");
  assert.equal(ranked[0]?.finalScore, expectedHigh);
  assert.equal(ranked[1]?.finalScore, expectedLow);
  assert.ok(expectedHigh > expectedLow);
});

test("summary quality multiplier stays inside [1-delta, 1] at shipped delta", () => {
  const now = Date.now();
  const ranked = scoreCandidates([
    {
      id: "best-summary",
      score: 1,
      text: "best summary",
      metadata: { type: "summary", decay_rate: 0, ts: now, sessionId: "s1" },
    },
    {
      id: "worst-summary",
      score: 1,
      text: "worst summary",
      metadata: { type: "summary", decay_rate: 1, ts: now, sessionId: "s1" },
    },
  ], {
    alpha: 1,
    beta: 0,
    gamma: 0,
    delta: 0.5,
    sessionId: "s1",
    userId: "u1",
  });

  assert.equal(ranked[0]?.finalScore, 1);
  assert.equal(ranked[1]?.finalScore, 0.5);
});

test("expandSummaryCandidates honors confidence, depth, and token budget", async () => {
  const calls: Array<{ summaryId: string; depth: number }> = [];
  const items: SearchResult[] = [
    {
      id: "summary-a",
      score: 0.9,
      text: "summary a",
      metadata: { type: "summary", confidence: 0.8, sessionId: "s1" },
    },
    {
      id: "summary-b",
      score: 0.9,
      text: "summary b",
      metadata: { type: "summary", confidence: 0.95, sessionId: "s1" },
    },
    {
      id: "raw-c",
      score: 0.9,
      text: "raw c",
      metadata: { type: "turn", confidence: 1, sessionId: "s1" },
    },
  ];

  const expanded = await expandSummaryCandidates(
    items,
    async (_sessionId: string, summaryId: string, depth: number) => {
      calls.push({ summaryId, depth });
      return summaryId === "summary-a"
        ? [
            { id: "child-1", score: 0.9, text: "child one", metadata: { token_estimate: 3 } },
            { id: "child-2", score: 0.8, text: "child two", metadata: {} },
          ]
        : [
            { id: "child-3", score: 0.7, text: "child three", metadata: { token_estimate: 3 } },
          ];
    },
    "s1",
    {
      confidenceThreshold: 0.7,
      maxDepth: 2,
      tokenBudget: 5,
      penaltyFactor: 0.5,
    },
  );

  assert.deepEqual(calls, [
    { summaryId: "summary-a", depth: 2 },
    { summaryId: "summary-b", depth: 2 },
  ]);
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0]?.id, "child-1");
  assert.equal(expanded[0]?.metadata.expanded_from_summary, true);
  assert.equal(expanded[0]?.metadata.parent_summary_id, "summary-a");
  assert.equal(expanded[0]?.metadata.expansion_depth, 1);
  assert.equal(expanded[0]?.finalScore, 0.45);
});

test("session recency decay uses seconds, not milliseconds", () => {
  const now = Date.now();
  const oneHourOld: SearchResult[] = [
    {
      id: "session-hour-old",
      score: 0,
      text: "hour old session memory",
      metadata: { ts: now - 3_600_000, sessionId: "s1" },
    },
  ];

  const ranked = scoreCandidates(oneHourOld, {
    alpha: 0,
    beta: 0.2,
    gamma: 0.1,
    recencyLambdaSession: 0.0001,
    recencyLambdaUser: 0.00001,
    recencyLambdaGlobal: 0.000002,
    sessionId: "s1",
    userId: "u1",
  });

  const expectedRecency = Math.exp(-0.0001 * 3600);
  const expectedScore = (2 / 3) * expectedRecency + (1 / 3);
  assert.ok(Math.abs((ranked[0]?.finalScore ?? 0) - expectedScore) < 0.01);
  assert.ok((ranked[0]?.finalScore ?? 0) > 0.2);
});

test("scoreCandidates clamps negative retrieval scores to preserve [0,1] host math", () => {
  const now = Date.now();
  const ranked = scoreCandidates([
    {
      id: "negative-hit",
      score: -0.8,
      text: "negative similarity hit",
      metadata: { ts: now, sessionId: "s1" },
    },
  ], {
    alpha: 1,
    beta: 0,
    gamma: 0,
    sessionId: "s1",
    userId: "u1",
  });

  assert.equal(ranked[0]?.finalScore, 0);
});

test("scoreCandidates normalizes weights back onto the convex mixture", () => {
  const now = Date.now();
  const ranked = scoreCandidates([
    {
      id: "bounded-hit",
      score: 1,
      text: "bounded hit",
      metadata: { ts: now, sessionId: "s1" },
    },
  ], {
    alpha: 10,
    beta: 10,
    gamma: 10,
    delta: 2,
    sessionId: "s1",
    userId: "u1",
  });

  assert.ok((ranked[0]?.finalScore ?? 0) <= 1);
  assert.ok((ranked[0]?.finalScore ?? 0) >= 0);
});

test("rankSection7VariantCandidates filters coarse candidates below theta1", () => {
  const now = Date.now();
  const ranked = rankSection7VariantCandidates([
    {
      id: "keep",
      score: 0.8,
      text: "governing math continuity budget",
      metadata: { ts: now, collection: "global" },
    },
    {
      id: "drop",
      score: 0.1,
      text: "irrelevant chatter",
      metadata: { ts: now, collection: "global" },
    },
  ], {
    queryText: "continuity math budget",
    sessionId: "s1",
    userId: "u1",
    k1: 8,
    k2: 8,
    theta1: 0.2,
    kappa: 0.3,
    nowMs: now,
  });

  assert.deepEqual(ranked.map((item) => item.id), ["keep"]);
});

test("rankSection7VariantCandidates matches normalized second-pass law under fixed authority", () => {
  const now = Date.now();
  const ranked = rankSection7VariantCandidates([
    {
      id: "doc",
      score: 0.8,
      text: "math continuity budget",
      metadata: {
        ts: now,
        authority: 1,
        access_count: 0,
        collection: "authored:variant",
      },
    },
  ], {
    queryText: "math continuity",
    sessionId: "s1",
    userId: "u1",
    k1: 4,
    k2: 4,
    theta1: 0,
    kappa: 0.3,
    authorityRecencyLambda: 0,
    authorityRecencyWeight: 0,
    authorityFrequencyWeight: 0,
    authorityAuthoredWeight: 1,
    nowMs: now,
  });

  const expectedCoverage = 1;
  const expectedFinal = 0.8 * ((1 + 0.3 * expectedCoverage) / (1 + 0.3));
  assert.equal(ranked.length, 1);
  assert.ok(Math.abs((ranked[0]?.finalScore ?? 0) - expectedFinal) < 1e-12);
});

test("rankSection7VariantCandidates favors higher authority at equal semantic similarity", () => {
  const now = Date.now();
  const ranked = rankSection7VariantCandidates([
    {
      id: "authoritative",
      score: 0.7,
      text: "math continuity budget",
      metadata: { ts: now, authority: 1, collection: "authored:variant" },
    },
    {
      id: "plain",
      score: 0.7,
      text: "math continuity budget",
      metadata: { ts: now, authority: 0, collection: "global" },
    },
  ], {
    queryText: "math continuity",
    sessionId: "s1",
    userId: "u1",
    k1: 4,
    k2: 4,
    theta1: 0,
    kappa: 0.3,
    authorityRecencyLambda: 0,
    authorityRecencyWeight: 0,
    authorityFrequencyWeight: 0,
    authorityAuthoredWeight: 1,
    nowMs: now,
  });

  assert.equal(ranked[0]?.id, "authoritative");
  assert.ok((ranked[0]?.finalScore ?? 0) > (ranked[1]?.finalScore ?? 0));
});

test("expandSection7HopCandidates applies etaHop to the best parent score", () => {
  const expanded = expandSection7HopCandidates(
    [
      {
        id: "parent-a",
        score: 0.8,
        finalScore: 0.9,
        text: "parent a",
        metadata: { hop_targets: ["hop-1", "hop-2"] },
      },
      {
        id: "parent-b",
        score: 0.6,
        finalScore: 0.7,
        text: "parent b",
        metadata: { hop_targets: ["hop-1"] },
      },
    ],
    [
      {
        id: "hop-1",
        score: 0,
        text: "hop one",
        metadata: { authored: true, collection: "authored:variant" },
      },
      {
        id: "hop-2",
        score: 0,
        text: "hop two",
        metadata: { authored: true, collection: "authored:variant" },
      },
    ],
    {
      etaHop: 0.5,
      thetaHop: 0.1,
    },
  );

  assert.deepEqual(expanded.map((item) => item.id), ["hop-1", "hop-2"]);
  assert.equal(expanded[0]?.finalScore, 0.45);
  assert.equal(expanded[1]?.finalScore, 0.45);
});

test("expandSection7HopCandidates filters by thetaHop and excludes existing ranked docs", () => {
  const expanded = expandSection7HopCandidates(
    [
      {
        id: "parent",
        score: 0.8,
        finalScore: 0.3,
        text: "parent",
        metadata: { hop_targets: ["keep", "drop", "parent"] },
      },
    ],
    [
      {
        id: "keep",
        score: 0,
        text: "keep me",
        metadata: { authored: true, collection: "authored:variant" },
      },
      {
        id: "drop",
        score: 0,
        text: "drop me",
        metadata: { authored: true, collection: "authored:variant" },
      },
    ],
    {
      etaHop: 0.5,
      thetaHop: 0.2,
    },
  );

  assert.deepEqual(expanded.map((item) => item.id), []);
});

test("mergeSection7VariantCandidates sorts residual assembly by descending sigma across C2 and hop candidates", () => {
  const merged = mergeSection7VariantCandidates(
    [
      {
        id: "c2-high",
        score: 0.8,
        finalScore: 0.9,
        text: "direct top result",
        metadata: { collection: "global" },
      },
      {
        id: "c2-low",
        score: 0.3,
        finalScore: 0.2,
        text: "direct low result",
        metadata: { collection: "global" },
      },
    ],
    [
      {
        id: "hop-mid",
        score: 0,
        finalScore: 0.45,
        text: "expanded hop result",
        metadata: { collection: "authored:variant" },
      },
    ],
  );

  assert.deepEqual(merged.map((item) => item.id), ["c2-high", "hop-mid", "c2-low"]);
});

test("rankSection7VariantCandidates stays bounded with empty keywords and cold-start access counts", () => {
  const now = Date.now();
  const ranked = rankSection7VariantCandidates([
    {
      id: "doc",
      score: 0.7,
      text: "plain document text",
      metadata: { ts: now, access_count: 0, authority: 0, collection: "global" },
    },
  ], {
    queryText: "!!",
    sessionId: "s1",
    userId: "u1",
    k1: 4,
    k2: 4,
    theta1: -1,
    kappa: 0.3,
    nowMs: now,
  });

  assert.equal(ranked.length, 1);
  assert.ok(Number.isFinite(ranked[0]?.finalScore ?? NaN));
  assert.ok((ranked[0]?.finalScore ?? -1) >= 0);
  assert.ok((ranked[0]?.finalScore ?? 2) <= 1);
});

test("rankRawUserRecoveryCandidates favors tighter lexical match over broader topical turn", () => {
  const now = Date.now();
  const { ranked, debug } = rankRawUserRecoveryCandidates([
    {
      id: "broad-topic",
      score: 0.92,
      text: "I am trying to get more organized and stay on top of my tasks with better productivity tools.",
      metadata: { ts: now - 60_000, userId: "u1" },
    },
    {
      id: "exact-turn",
      score: 0.74,
      text: "I joined a Data Analysis using Python webinar and want to pick between Matplotlib or Seaborn for charts.",
      metadata: { ts: now - 30_000, userId: "u1" },
    },
  ], {
    queryText: "Should I start with Matplotlib or Seaborn after my Data Analysis using Python webinar?",
    nowMs: now,
  });

  assert.equal(ranked[0]?.id, "exact-turn");
  assert.equal(debug[0]?.id, "exact-turn");
  assert.ok((debug[0]?.temporalAnchorDensity ?? -1) >= 0);
  assert.ok((debug[0]?.temporalAnchorDensity ?? 2) <= 1);
  assert.ok((debug[0]?.lexicalCoverage ?? 0) > (debug[1]?.lexicalCoverage ?? 0));
  assert.match(debug[0]?.rationale ?? "", /intent phrase overlap|lexical coverage/);
});
