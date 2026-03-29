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
