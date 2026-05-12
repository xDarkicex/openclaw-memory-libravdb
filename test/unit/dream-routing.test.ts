import test from "node:test";
import assert from "node:assert/strict";

import { detectDreamQuerySignal, resolveDreamCollection } from "../../src/dream-routing.js";

test("dream routing detects explicit dream phrasing", () => {
  assert.equal(detectDreamQuerySignal("tell me about your dreams from last week").active, true);
  assert.equal(detectDreamQuerySignal("what did I dream about on sunday").active, true);
  assert.equal(detectDreamQuerySignal("I had a dream about vector databases").active, true);
  assert.equal(detectDreamQuerySignal("do you remember the dream about the ocean").active, true);
  assert.equal(detectDreamQuerySignal("recall my dream from yesterday").active, true);
  assert.equal(detectDreamQuerySignal("my dreams from last night").active, true);
  assert.equal(detectDreamQuerySignal("our dreams about the project").active, true);
  assert.equal(detectDreamQuerySignal("dream about the conference").active, true);
  assert.equal(detectDreamQuerySignal("dreamed about flying").active, true);
  assert.equal(detectDreamQuerySignal("dreaming about the exam").active, true);
  assert.equal(detectDreamQuerySignal("dream diary entry for monday").active, true);
  assert.equal(detectDreamQuerySignal("dream journal from last week").active, true);
  assert.equal(detectDreamQuerySignal("dreams about the architecture").active, true);
  assert.equal(detectDreamQuerySignal("what was I dreaming about last night").active, true);
  assert.equal(detectDreamQuerySignal("tell me about dreams").active, true);
  assert.equal(detectDreamQuerySignal("dream memories from yesterday").active, true);
  assert.equal(detectDreamQuerySignal("dream recall practice").active, true);
});

test("dream routing rejects idiomatic false positives", () => {
  assert.equal(detectDreamQuerySignal("pipe dream architecture").active, false);
  assert.equal(detectDreamQuerySignal("pipe dreams everywhere").active, false);
  assert.equal(detectDreamQuerySignal("the American dream").active, false);
  assert.equal(detectDreamQuerySignal("dream team meeting").active, false);
  assert.equal(detectDreamQuerySignal("dream house renovation").active, false);
  assert.equal(detectDreamQuerySignal("dream vacation planning").active, false);
  assert.equal(detectDreamQuerySignal("dream job listing").active, false);
  assert.equal(detectDreamQuerySignal("dream car wishlist").active, false);
  assert.equal(detectDreamQuerySignal("dream wedding venue").active, false);
  assert.equal(detectDreamQuerySignal("dream school application").active, false);
  assert.equal(detectDreamQuerySignal("dream home interior design").active, false);
  assert.equal(detectDreamQuerySignal("in my dreams").active, false);
  assert.equal(detectDreamQuerySignal("in your dreams").active, false);
});

test("dream routing ignores ordinary memory queries", () => {
  assert.equal(detectDreamQuerySignal("what did we decide about the vector store").active, false);
  assert.equal(detectDreamQuerySignal("summarize my notes from last week").active, false);
  assert.equal(detectDreamQuerySignal("how do I configure the memory").active, false);
  assert.equal(detectDreamQuerySignal("recall the meeting notes").active, false);
  assert.equal(detectDreamQuerySignal("remember what we discussed about caching").active, false);
});

test("dream routing resolves the dedicated dream collection name", () => {
  assert.equal(resolveDreamCollection("u1"), "dream:u1");
  assert.equal(resolveDreamCollection("  session-key:abc  "), "dream:session-key:abc");
});