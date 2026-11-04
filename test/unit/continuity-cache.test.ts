import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { ContinuityCache } from "../../src/continuity-cache.js";

test("continuity keeps untouched legacy sessions and prefers their newer individual entries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-legacy-"));
  try {
    const legacyFile = path.join(root, "libravdb-continuity-cache.json");
    const original = JSON.stringify({ "session/a": "old A", "session_a": "old B" });
    fs.writeFileSync(legacyFile, original);
    const first = new ContinuityCache(root);
    const second = new ContinuityCache(root);
    assert.equal(first.read("session/a"), "old A");
    second.write("session_a", "new B");
    assert.equal(first.read("session_a"), "new B", "an existing reader sees another instance's write");
    assert.equal(first.read("session/a"), "old A");
    first.write("session/a", "new A");
    assert.equal(new ContinuityCache(root).read("session/a"), "new A");
    assert.equal(new ContinuityCache(root).read("session_a"), "new B");
    assert.equal(fs.readFileSync(legacyFile, "utf8"), original);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed atomic continuity replacement leaves the prior value and other sessions intact", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-atomic-"));
  const cache = new ContinuityCache(root);
  cache.write("a", "confirmed A");
  cache.write("b", "confirmed B");
  const mocked = t.mock.method(fs, "renameSync", () => { throw new Error("replacement denied"); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => cache.write("a", "incomplete A"), /replacement denied/);
    assert.equal(new ContinuityCache(root).read("a"), "confirmed A");
    assert.equal(new ContinuityCache(root).read("b"), "confirmed B");
    assert.equal(fs.readdirSync(path.join(root, "libravdb-continuity")).some(name => name.endsWith(".tmp")), false);
    mocked.mock.restore(); syncBuiltinESMExports();
    cache.write("a", "retried A");
    assert.equal(new ContinuityCache(root).read("a"), "retried A");
  } finally {
    mocked.mock.restore(); syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
