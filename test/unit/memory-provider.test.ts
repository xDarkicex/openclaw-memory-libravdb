import test from "node:test";
import assert from "node:assert/strict";

import { buildMemoryPromptSection } from "../../src/memory-provider.js";

test("memory prompt section returns string array", () => {
  const section = buildMemoryPromptSection();
  const result = section({
    availableTools: new Set(["read", "exec"]),
  });

  assert.ok(Array.isArray(result), "result should be an array");
  assert.ok(result.length > 0, "result should not be empty");
  for (const line of result) {
    assert.equal(typeof line, "string", "each element should be a string");
  }
});

test("memory prompt section works with citationsMode", () => {
  const section = buildMemoryPromptSection();
  const result = section({
    availableTools: new Set(),
    citationsMode: "inline",
  });

  assert.ok(Array.isArray(result));
  assert.ok(result.some((line) => line.toLowerCase().includes("memory")));
});
