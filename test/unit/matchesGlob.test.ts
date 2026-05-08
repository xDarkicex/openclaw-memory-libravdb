import test from "node:test";
import assert from "node:assert/strict";

import { matchesGlob } from "../../src/markdown-ingest.js";

test("matchesGlob: single-segment wildcard matches files in same directory", () => {
  assert.equal(matchesGlob("notes/draft.md", "notes/*.md"), true);
  assert.equal(matchesGlob("notes/final.md", "notes/*.md"), true);
  assert.equal(matchesGlob("notes/sub/deep.md", "notes/*.md"), false);
  assert.equal(matchesGlob("draft.md", "*.md"), true);
});

test("matchesGlob: **/ matches across path segments", () => {
  assert.equal(matchesGlob("private/secret.md", "**/private/**"), true);
  assert.equal(matchesGlob("a/private/b/secret.md", "**/private/**"), true);
  assert.equal(matchesGlob("deep/nested/private/dir/secret.md", "**/private/**"), true);
  assert.equal(matchesGlob("private.md", "**/private/**"), false);
  assert.equal(matchesGlob("xprivate/y.md", "**/private/**"), false);
});

test("matchesGlob: **/*.md matches deeply nested markdown files", () => {
  assert.equal(matchesGlob("docs/readme.md", "docs/**/*.md"), true);
  assert.equal(matchesGlob("docs/a/b/c.md", "docs/**/*.md"), true);
  assert.equal(matchesGlob("docs/guide/intro.md", "docs/**/*.md"), true);
  assert.equal(matchesGlob("src/index.ts", "docs/**/*.md"), false);
  assert.equal(matchesGlob("other/readme.md", "docs/**/*.md"), false);
});

test("matchesGlob: ? matches a single non-slash character", () => {
  assert.equal(matchesGlob("ab", "??"), true);
  assert.equal(matchesGlob("a", "??"), false);
  assert.equal(matchesGlob("abc", "??"), false);
  assert.equal(matchesGlob("a/b", "??"), false);
  assert.equal(matchesGlob("Makefile", "?akefile"), true);
  assert.equal(matchesGlob("makefile", "?akefile"), true);
});

test("matchesGlob: character classes match single characters", () => {
  assert.equal(matchesGlob("Makefile", "[Mm]akefile"), true);
  assert.equal(matchesGlob("makefile", "[Mm]akefile"), true);
  assert.equal(matchesGlob("akefile", "[Mm]akefile"), false);
  assert.equal(matchesGlob("akefile", "[a-c]kefile"), true);
});

test("matchesGlob: negated character classes with !", () => {
  // [!abc] is glob syntax for "not a, b, or c" — should translate to [^abc]
  assert.equal(matchesGlob("draft.md", "[!.]*"), true);
  assert.equal(matchesGlob(".hidden", "[!.]*"), false);
  assert.equal(matchesGlob("readme.md", "[!.]*"), true);
});

test("matchesGlob: brace expansion matches alternatives", () => {
  assert.equal(matchesGlob("notes/draft.md", "notes/{draft,final}.md"), true);
  assert.equal(matchesGlob("notes/final.md", "notes/{draft,final}.md"), true);
  assert.equal(matchesGlob("notes/archive.md", "notes/{draft,final}.md"), false);
});

test("matchesGlob: literal characters and dots match exactly", () => {
  assert.equal(matchesGlob("config.yaml", "config.yaml"), true);
  assert.equal(matchesGlob("configyml", "config.yaml"), false);
  assert.equal(matchesGlob(".hidden", ".hidden"), true);
  assert.equal(matchesGlob("hidden", ".hidden"), false);
});

test("matchesGlob: combined patterns work together", () => {
  assert.equal(matchesGlob("src/utils/helpers.ts", "src/**/*.ts"), true);
  assert.equal(matchesGlob("src/utils/helpers.js", "src/**/*.ts"), false);
  assert.equal(matchesGlob("docs/v2/guide.md", "docs/v[12]/**/*.{md,txt}"), true);
  assert.equal(matchesGlob("docs/v2/guide.txt", "docs/v[12]/**/*.{md,txt}"), true);
  assert.equal(matchesGlob("docs/v3/guide.md", "docs/v[12]/**/*.{md,txt}"), false);
});