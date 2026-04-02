import test from "node:test";
import assert from "node:assert/strict";

import { selectRecentTail } from "../../src/continuity.js";

test("selectRecentTail preserves the minimum suffix when it exceeds the token target", () => {
  const items = [
    { id: "a", cost: 20 },
    { id: "b", cost: 20 },
    { id: "c", cost: 20 },
    { id: "d", cost: 20 },
  ];

  const selected = selectRecentTail(items, {
    minTurns: 3,
    tailBudgetTokens: 30,
    tokenCost: (item) => item.cost,
  });

  assert.deepEqual(selected.older.map((item) => item.id), ["a"]);
  assert.deepEqual(selected.base.map((item) => item.id), ["b", "c", "d"]);
  assert.deepEqual(selected.recent.map((item) => item.id), ["b", "c", "d"]);
});

test("selectRecentTail extends backward to the longest suffix within budget", () => {
  const items = [
    { id: "a", cost: 20 },
    { id: "b", cost: 20 },
    { id: "c", cost: 20 },
    { id: "d", cost: 20 },
  ];

  const selected = selectRecentTail(items, {
    minTurns: 2,
    tailBudgetTokens: 60,
    tokenCost: (item) => item.cost,
  });

  assert.deepEqual(selected.older.map((item) => item.id), ["a"]);
  assert.deepEqual(selected.base.map((item) => item.id), ["c", "d"]);
  assert.deepEqual(selected.recent.map((item) => item.id), ["b", "c", "d"]);
});
