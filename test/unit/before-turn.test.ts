import test from "node:test";
import assert from "node:assert/strict";

import { TurnMemoryCache, extractQueryHint, isNewUserTurn } from "../../src/turn-cache.js";

test("extractQueryHint returns last user message text", () => {
  const messages = [
    { role: "user", content: "what is my favorite color?" },
    { role: "assistant", content: "I don't know yet." },
  ];
  const hint = extractQueryHint(messages, (t) => t);
  assert.ok(hint?.includes("favorite color"));
});

test("extractQueryHint skips non-user messages", () => {
  const messages = [
    { role: "assistant", content: "hello" },
    { role: "toolResult", content: "done" },
  ];
  const hint = extractQueryHint(messages, (t) => t);
  assert.equal(hint, null);
});

test("extractQueryHint handles content array", () => {
  const messages = [
    {
      role: "user",
      content: [{ type: "text", text: "hello world" }],
    },
  ];
  const hint = extractQueryHint(messages, (t) => t);
  assert.ok(hint?.includes("hello world"));
});

test("extractQueryHint truncates to 200 chars", () => {
  const longText = "a".repeat(500);
  const messages = [{ role: "user", content: longText }];
  const hint = extractQueryHint(messages, (t) => t);
  assert.equal(hint?.length, 200);
});

test("isNewUserTurn detects new user turn", () => {
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "second question" },
  ];
  assert.equal(isNewUserTurn(messages), true);
});

test("isNewUserTurn returns false for tool-result only after assistant", () => {
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "toolResult", content: "result" },
  ];
  assert.equal(isNewUserTurn(messages), false);
});

test("isNewUserTurn returns true for empty context", () => {
  assert.equal(isNewUserTurn([]), true);
});

test("TurnMemoryCache caches and retrieves", () => {
  const cache = new TurnMemoryCache(10);
  const value = { ok: true, predictions: [] };
  cache.set("session-1", "what is my color?", value);
  const retrieved = cache.get("session-1", "what is my color?");
  assert.deepEqual(retrieved, value);
});

test("TurnMemoryCache normalizes query keys", () => {
  const cache = new TurnMemoryCache(10);
  cache.set("s1", "WHAT is my COLOR?", { a: 1 });
  const hit = cache.get("s1", "what is my color?");
  assert.deepEqual(hit, { a: 1 });
});

test("TurnMemoryCache evicts LRU", () => {
  const cache = new TurnMemoryCache(2);
  cache.set("s1", "q1", 1);
  cache.set("s1", "q2", 2);
  // Touch q1 to promote it — q2 becomes LRU tail.
  assert.equal(cache.get("s1", "q1"), 1);
  cache.set("s1", "q3", 3); // evicts q2 (LRU), not q1
  assert.equal(cache.get("s1", "q2"), undefined);
  assert.equal(cache.get("s1", "q1"), 1);
  assert.equal(cache.get("s1", "q3"), 3);
});

test("TurnMemoryCache invalidates session", () => {
  const cache = new TurnMemoryCache(10);
  cache.set("s1", "q1", 1);
  cache.set("s2", "q1", 2);
  cache.invalidateSession("s1");
  assert.equal(cache.get("s1", "q1"), undefined);
  assert.equal(cache.get("s2", "q1"), 2);
});

test("TurnMemoryCache keeps session ids containing separators isolated", () => {
  const cache = new TurnMemoryCache(10);
  cache.set("agent:main", "2:question", { session: "agent:main" });
  assert.equal(cache.get("agent:main:2", "question"), undefined);

  cache.set("agent:main:2", "question", { session: "agent:main:2" });
  assert.deepEqual(cache.get("agent:main", "2:question"), { session: "agent:main" });
  assert.deepEqual(cache.get("agent:main:2", "question"), { session: "agent:main:2" });

  cache.invalidateSession("agent:main");
  assert.equal(cache.get("agent:main", "2:question"), undefined);
  assert.deepEqual(cache.get("agent:main:2", "question"), { session: "agent:main:2" });
});

test("TurnMemoryCache escapes quotes and backslashes in session ids", () => {
  const cache = new TurnMemoryCache(10);
  const sessionId = 'agent:"main\\branch';
  cache.set(sessionId, "query", 1);
  cache.set(`${sessionId}:child`, "query", 2);
  cache.invalidateSession(sessionId);
  assert.equal(cache.get(sessionId, "query"), undefined);
  assert.equal(cache.get(`${sessionId}:child`, "query"), 2);
});
