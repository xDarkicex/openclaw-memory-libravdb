import test from "node:test";
import assert from "node:assert/strict";

import { parseDreamPromotionCandidates } from "../../src/dream-promotion.js";

test("dream promotion parser only accepts explicit deep-sleep candidate bullets", () => {
  const candidates = parseDreamPromotionCandidates(
    [
      "# DREAMS",
      "",
      "## Light Sleep",
      "- Ignore this one {score=0.9 recall=3 unique=2}",
      "",
      "## Deep Sleep",
      "- Preserve the recent tail buffer {score=0.82 recall=3 unique=2}",
      "- too weak to promote {score=0.4 recall=1 unique=1}",
      "",
      "## REM Sleep",
      "- Not a promotion target {score=0.95 recall=5 unique=4}",
    ].join("\n"),
  );

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]?.text, "Preserve the recent tail buffer");
  assert.equal(candidates[0]?.score, 0.82);
  assert.equal(candidates[0]?.recallCount, 3);
  assert.equal(candidates[0]?.uniqueQueries, 2);
  assert.equal(candidates[1]?.text, "too weak to promote");
});
