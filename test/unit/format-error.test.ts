import test from "node:test";
import assert from "node:assert/strict";

import { formatError } from "../../src/format-error.js";

test("formatError returns trimmed Error message for non-blank messages", () => {
  assert.equal(formatError(new Error("  something went wrong  ")), "something went wrong");
  assert.equal(formatError(new Error("plain error")), "plain error");
});

test("formatError falls back to String() for blank Error messages", () => {
  assert.equal(formatError(new Error("")), "Error");
  // String(new Error("   ")) produces "Error:    " — the function still falls through
  assert.equal(formatError(new Error("   ")), "Error:    ");
});

test("formatError falls back to String() for non-Error values", () => {
  assert.equal(formatError("a string throw"), "a string throw");
  assert.equal(formatError(42), "42");
  assert.equal(formatError(null), "null");
  assert.equal(formatError(undefined), "undefined");
  assert.equal(formatError({ toString() { return "custom"; } }), "custom");
});
