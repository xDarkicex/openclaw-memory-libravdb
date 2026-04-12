import assert from "node:assert/strict";
import test from "node:test";

import {
  decideTemporalSelectorGuard,
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

test("decideTemporalSelectorGuard applies only to strong two-slot temporal queries", () => {
  const twoSlot = decideTemporalSelectorGuard(
    "How many days did it take for me to find a house I loved after starting to work with Rachel?",
  );
  const comparisonQuery = decideTemporalSelectorGuard(
    "Which event did I attend first, the Effective Time Management workshop or the Data Analysis using Python webinar?",
  );
  const overFragmented = decideTemporalSelectorGuard(
    "How many days had passed between the Sunday mass at St. Mary's Church and the Ash Wednesday service at the cathedral?",
  );

  assert.equal(twoSlot.shouldApply, true);
  assert.equal(twoSlot.slots.length, 2);
  assert.equal(comparisonQuery.shouldApply, true);
  assert.ok(comparisonQuery.slots.length >= 1);
  assert.ok(comparisonQuery.slots.length <= 4);
  assert.match(comparisonQuery.reason, /comparison query/);
  assert.equal(overFragmented.shouldApply, false);
  assert.match(overFragmented.reason, /exactly two temporal slots/);
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

test("rankTemporalRecoveryCandidates filters generic comparison slots before scoring sides", () => {
  resetTemporalCachesForTest();

  const now = Date.now();
  const result = rankTemporalRecoveryCandidates([
    {
      id: "broad-travel-context",
      score: 0.90,
      text: "I enjoyed both the Europe trip and the solo trip to Thailand, and each of them helped me think more clearly about the kind of travel I want to do next.",
      metadata: { ts: now - 20_000, userId: "u1", collection: "turns:u1" },
    },
    {
      id: "europe-anchor",
      score: 0.68,
      text: "Just last month, I went on a two-week trip to Europe with my parents and younger brother, and it was a really different experience from traveling on my own.",
      metadata: { ts: now - 10_000, userId: "u1", collection: "turns:u1" },
    },
    {
      id: "thailand-anchor",
      score: 0.66,
      text: "I had experience traveling solo before when I went to Thailand in 2023, and I liked being able to set my own pace and itinerary.",
      metadata: { ts: now - 5_000, userId: "u1", collection: "turns:u1" },
    },
  ], {
    queryText: "Which trip did I take first, the one to Europe with family or the solo trip to Thailand?",
    nowMs: now,
    maxSelected: 3,
  });

  assert.equal(result.temporalQuery.active, true);
  assert.deepEqual(result.slots, ["one europe family", "solo trip thailand"]);
  assert.ok((result.ranked.find((item) => item.id === "thailand-anchor")?.finalScore ?? 0) >
    (result.ranked.find((item) => item.id === "europe-anchor")?.finalScore ?? 0));
});

test("rankTemporalRecoveryCandidates does not affiliate Europe travel context to Thailand on generic solo-trip overlap", () => {
  resetTemporalCachesForTest();

  const now = Date.now();
  const result = rankTemporalRecoveryCandidates([
    {
      id: "europe-with-solo-language",
      score: 0.72,
      text: "I went on a two-week trip to Europe with my parents and younger brother, and it felt really different from traveling solo.",
      metadata: { ts: now - 10_000, userId: "u1", collection: "turns:u1" },
    },
    {
      id: "thailand-anchor",
      score: 0.66,
      text: "I had experience traveling solo before when I went to Thailand in 2023, and I liked being able to set my own pace and itinerary.",
      metadata: { ts: now - 5_000, userId: "u1", collection: "turns:u1" },
    },
  ], {
    queryText: "Which trip did I take first, the one to Europe with family or the solo trip to Thailand?",
    nowMs: now,
    maxSelected: 2,
  });

  const europeContext = result.debug.find((item) => item.id === "europe-with-solo-language");
  assert.ok(europeContext);
  assert.notEqual(europeContext.comparisonSide, 1);
});

test("rankTemporalRecoveryCandidates reserves one feasible witness per comparison side before greedy fill", () => {
  resetTemporalCachesForTest();

  const now = Date.now();
  const result = rankTemporalRecoveryCandidates([
    {
      id: "broad-mesh",
      score: 0.90,
      text: "I just upgraded to a mesh network system and want a desktop setup that can really take advantage of the faster internet throughout the house.",
      metadata: { ts: now - 20_000, userId: "u1", collection: "turns:u1" },
    },
    {
      id: "thermostat-exact",
      score: 0.64,
      text: "I set up my smart thermostat a month ago, and it has been learning my routine and reducing my energy bills.",
      metadata: { ts: now - 15_000, userId: "u1", collection: "turns:u1" },
    },
    {
      id: "mesh-exact",
      score: 0.66,
      text: "I upgraded to a mesh network system three weeks ago, and it fixed the dead zones around the house.",
      metadata: { ts: now - 10_000, userId: "u1", collection: "turns:u1" },
    },
  ], {
    queryText: "Which device did I set up first, the smart thermostat or the mesh network system?",
    nowMs: now,
    maxSelected: 3,
    selectionTokenBudget: 200,
  });

  assert.equal(result.comparisonCoverageApplied, true);
  assert.deepEqual(result.comparisonCoverageSlots, ["smart thermostat", "mesh network system"]);
  assert.ok((result.comparisonCoverageMinTokens ?? 0) > 0);
  assert.ok(result.ranked.slice(0, 2).some((item) => item.id === "thermostat-exact"));
  assert.ok(result.ranked.slice(0, 2).some((item) => item.id === "mesh-exact" || item.id === "broad-mesh"));
});

test("rankTemporalRecoveryCandidates falls through when side coverage is infeasible under the selection budget", () => {
  resetTemporalCachesForTest();

  const now = Date.now();
  const result = rankTemporalRecoveryCandidates([
    {
      id: "volleyball-long",
      score: 0.82,
      text: "I've been trying to improve my overall fitness lately, and I think it all started about 2 months ago when I joined a recreational volleyball league with some friends from work. We've been playing every Thursday evening at the local community center, and I've really been enjoying it. I've been trying to get to the gym more regularly to improve my overall fitness, focusing on cardio and strength training. My serves have improved, my stamina is better, and I've started planning the rest of my week around those games because they've become such a meaningful part of my routine.",
      metadata: { ts: now - 15_000, userId: "u1", collection: "turns:u1" },
    },
    {
      id: "charity-short",
      score: 0.74,
      text: "I recently did a charity 5K run for a local children's hospital, and it was a great experience.",
      metadata: { ts: now - 10_000, userId: "u1", collection: "turns:u1" },
    },
  ], {
    queryText: "Which event did I participate in first, the volleyball league or the charity 5K run to raise money for a local children's hospital?",
    nowMs: now,
    maxSelected: 3,
    selectionTokenBudget: 60,
  });

  assert.equal(result.comparisonCoverageApplied, false);
  assert.ok((result.comparisonCoverageMinTokens ?? 0) > 60);
});

test("rankTemporalRecoveryCandidates reports lower position-weighted specificity for late analogical slot mentions", () => {
  resetTemporalCachesForTest();

  const now = Date.now();
  const result = rankTemporalRecoveryCandidates([
    {
      id: "late-thailand-reference",
      score: 0.80,
      text: "I'm considering planning a solo trip to South America and have been reading about crowded tourist spots. Did you have a similar solo travel experience in Thailand when visiting popular places?",
      metadata: { ts: now - 10_000, userId: "u1", collection: "turns:u1" },
    },
    {
      id: "early-thailand-experience",
      score: 0.78,
      text: "I was just sharing my own experience of traveling solo in Thailand last year, where I had complete freedom to do whatever I wanted and stayed in hostels.",
      metadata: { ts: now - 5_000, userId: "u1", collection: "turns:u1" },
    },
  ], {
    queryText: "Which trip did I take first, the one to Europe with family or the solo trip to Thailand?",
    nowMs: now,
    maxSelected: 2,
  });

  const lateReference = result.debug.find((item) => item.id === "late-thailand-reference");
  const earlyExperience = result.debug.find((item) => item.id === "early-thailand-experience");

  assert.ok(lateReference);
  assert.ok(earlyExperience);
  assert.ok((lateReference.comparisonSlotSpecificity ?? 0) > 0);
  assert.ok((earlyExperience.comparisonSlotSpecificity ?? 0) > 0);
  assert.ok(
    (lateReference.comparisonSlotPositionWeightedSpecificity ?? 0) <
      (lateReference.comparisonSlotSpecificity ?? 0),
  );
  assert.ok(
    typeof earlyExperience.comparisonSlotPositionWeightedSpecificity === "number",
  );
});

test("rankTemporalRecoveryCandidates reports lower pastness for planning turns than firsthand memories", () => {
  resetTemporalCachesForTest();

  const now = Date.now();
  const result = rankTemporalRecoveryCandidates([
    {
      id: "planning-turn",
      score: 0.80,
      text: "I'm considering planning a solo trip to South America and I'm wondering if you can help me with some research. I've been looking at different itineraries and trying to decide between destinations.",
      metadata: { ts: now - 10_000, userId: "u1", collection: "turns:u1" },
    },
    {
      id: "firsthand-memory",
      score: 0.78,
      text: "I was just sharing my own experience of traveling solo in Thailand last year, where I had complete freedom to do whatever I wanted and stayed in hostels.",
      metadata: { ts: now - 5_000, userId: "u1", collection: "turns:u1" },
    },
  ], {
    queryText: "Which trip did I take first, the one to Europe with family or the solo trip to Thailand?",
    nowMs: now,
    maxSelected: 2,
  });

  const planningTurn = result.debug.find((item) => item.id === "planning-turn");
  const firsthandMemory = result.debug.find((item) => item.id === "firsthand-memory");

  assert.ok(planningTurn);
  assert.ok(firsthandMemory);
  assert.ok((planningTurn.comparisonPastness ?? 0) < (firsthandMemory.comparisonPastness ?? 0));
});
