import assert from "node:assert/strict";
import test from "node:test";

import {
  detectTemporalQuerySignal,
  getTemporalAnchorDensity,
  rankTemporalRecoveryCandidates,
  resetTemporalCachesForTest,
} from "../../src/temporal.js";

test("detectTemporalQuerySignal activates on multiple temporal-compositional patterns", () => {
  const signal = detectTemporalQuerySignal(
    "How many days after I started working with Rachel did I find a house I loved?",
  );

  assert.equal(signal.active, true);
  assert.ok(signal.indicator >= 1 || signal.indicator >= 0.9);
  assert.ok(signal.matchedPatterns.includes("how many days"));
  assert.ok(signal.matchedPatterns.includes("before or after"));
});

test("detectTemporalQuerySignal stays inactive on non-temporal queries", () => {
  const signal = detectTemporalQuerySignal(
    "Can you recommend some homebuying tips for working with a real estate agent?",
  );

  assert.equal(signal.active, false);
  assert.equal(signal.indicator, 0);
  assert.deepEqual(signal.matchedPatterns, []);
});

test("getTemporalAnchorDensity is bounded and saturates on anchor-rich text", () => {
  resetTemporalCachesForTest();

  const density = getTemporalAnchorDensity(
    "turns:u1::doc-1",
    "I started on 2/15, saw a house on 3/1, and met Rachel again on March 4th at 10:30 AM.",
  );

  assert.ok(density > 0);
  assert.ok(density <= 1);
  assert.equal(density, 1);
});

test("getTemporalAnchorDensity returns stable cached values for repeated document lookups", () => {
  resetTemporalCachesForTest();

  const first = getTemporalAnchorDensity(
    "turns:u1::doc-2",
    "I attended Sunday mass on January 2nd and the Ash Wednesday service on February 1st.",
  );
  const second = getTemporalAnchorDensity(
    "turns:u1::doc-2",
    "I attended Sunday mass on January 2nd and the Ash Wednesday service on February 1st.",
  );

  assert.equal(first, second);
  assert.ok(first > 0);
});

test("rankTemporalRecoveryCandidates prefers complementary temporal anchors", () => {
  resetTemporalCachesForTest();

  const now = Date.now();
  const result = rankTemporalRecoveryCandidates([
    {
      id: "broad-rachel",
      score: 0.91,
      text: "I'm working with Rachel on finding a place near my office and want to know what neighborhoods are best.",
      metadata: { ts: now - 30_000, userId: "u1", collection: "turns:u1" },
    },
    {
      id: "date-anchor-house",
      score: 0.72,
      text: "I saw a house I loved on 3/1 and am thinking about making an offer.",
      metadata: { ts: now - 20_000, userId: "u1", collection: "turns:u1" },
    },
    {
      id: "date-anchor-start",
      score: 0.68,
      text: "I started working with Rachel on 2/15 and she has been helping with listings in my budget.",
      metadata: { ts: now - 10_000, userId: "u1", collection: "turns:u1" },
    },
  ], {
    queryText: "How many days did it take for me to find a house I loved after starting to work with Rachel?",
    nowMs: now,
    maxSelected: 3,
  });

  assert.equal(result.temporalQuery.active, true);
  assert.ok(result.slots.length >= 2);
  assert.ok(result.ranked.slice(0, 3).some((item) => item.id === "date-anchor-house"));
  assert.ok(result.ranked.slice(0, 3).some((item) => item.id === "date-anchor-start"));
  assert.ok(result.debug.filter((item) => item.selected).length >= 2);
});
