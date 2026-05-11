import test from "node:test";
import assert from "node:assert/strict";

import { getHashBackendName, hashBytes } from "../../src/markdown-hash.js";

test("markdown hash sentinel is stable and changes with content", () => {
  const left = hashBytes(new Uint8Array([1, 2, 3, 4]));
  const right = hashBytes(new Uint8Array([1, 2, 3, 4]));
  const different = hashBytes(new Uint8Array([1, 2, 3, 5]));

  assert.equal(left, right);
  assert.notEqual(left, different);
  assert.equal(left, "8010d29826a519fb");
});

test("markdown hash sentinel uses the wasm backend when available", () => {
  assert.equal(getHashBackendName(), "wasm-fnv1a64");
});

test("DEFAULT_SKIP_DIR_NAMES includes known irrelevant directories", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../src/markdown-ingest.ts", import.meta.url), "utf-8");
  const expected = ["node_modules", ".git", ".svn", ".hg", "dist", "build", "__pycache__", ".venv", "venv", ".next", ".nuxt", ".cache"];
  for (const name of expected) {
    assert.ok(source.includes(`"${name}"`), `DEFAULT_SKIP_DIR_NAMES should contain "${name}"`);
  }
});
