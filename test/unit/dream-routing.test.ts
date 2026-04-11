import test from "node:test";
import assert from "node:assert/strict";

import { detectDreamQuerySignal, resolveDreamCollection } from "../../src/dream-routing.js";

test("dream routing detects explicit dream phrasing", () => {
  assert.equal(detectDreamQuerySignal("tell me about your dreams from last week").active, true);
  assert.equal(detectDreamQuerySignal("what did I dream about on sunday").active, true);
  assert.equal(detectDreamQuerySignal("I had a dream about vector databases").active, true);
});

test("dream routing ignores ordinary memory queries", () => {
  assert.equal(detectDreamQuerySignal("what did we decide about the vector store").active, false);
  assert.equal(detectDreamQuerySignal("summarize my notes from last week").active, false);
});

test("dream routing resolves the dedicated dream collection name", () => {
  assert.equal(resolveDreamCollection("u1"), "dream:u1");
  assert.equal(resolveDreamCollection("  session-key:abc  "), "dream:session-key:abc");
});
