import test from "node:test";
import assert from "node:assert/strict";

import { scoreCandidates } from "../../src/scoring.js";
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
