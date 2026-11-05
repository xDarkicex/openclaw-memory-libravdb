import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDreamPromotionHandle, normalizeDiaryPath, parseDreamPromotionCandidates, promoteDreamDiaryFile } from "../../src/dream-promotion.js";

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

test("dream promotion parser accepts explicit promotion candidate headings", () => {
  const candidates = parseDreamPromotionCandidates(
    [
      "## Dream Promotion Candidates",
      "- Keep dream promotion {score=0.82 recall=3 unique=2}",
      "",
      "## Promotion Candidates",
      "- Keep promotion candidate {score=0.83 recall=4 unique=3}",
      "",
      "## Promote Candidates",
      "- Keep promote candidate {score=0.84 recall=5 unique=4}",
    ].join("\n"),
  );

  assert.deepEqual(
    candidates.map((candidate) => candidate.text),
    ["Keep dream promotion", "Keep promotion candidate", "Keep promote candidate"],
  );
});

test("dream promotion parser rejects substring-only section matches", () => {
  const candidates = parseDreamPromotionCandidates(
    [
      "## Daydreaming",
      "- Ignore daydreaming {score=0.9 recall=3 unique=2}",
      "",
      "## Dream Team",
      "- Ignore dream team {score=0.9 recall=3 unique=2}",
      "",
      "## Dreaming of Refactors",
      "- Ignore dreaming heading {score=0.9 recall=3 unique=2}",
      "",
      "## Promotional Content",
      "- Ignore promotional content {score=0.9 recall=3 unique=2}",
      "",
      "## Promote Your Work",
      "- Ignore promote your work {score=0.9 recall=3 unique=2}",
      "",
      "## Deep Sleepwalking",
      "- Ignore deep sleepwalking {score=0.9 recall=3 unique=2}",
      "",
      "## Deep Sleep",
      "- Keep explicit deep sleep {score=0.9 recall=3 unique=2}",
    ].join("\n"),
  );

  assert.deepEqual(
    candidates.map((candidate) => candidate.text),
    ["Keep explicit deep sleep"],
  );
});

test("dream promotion parser rejects partially parsed numeric metadata", () => {
  const candidates = parseDreamPromotionCandidates(
    [
      "## Deep Sleep",
      "- malformed score {score=0.82junk recall=3 unique=2}",
      "- malformed recall count {score=0.82 recall=3x unique=2}",
      "- malformed unique query count {score=0.82 recall=3 unique=2y}",
      "- valid metadata {score=8.2e-1 recall=3 unique=2}",
    ].join("\n"),
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.text, "valid metadata");
  assert.equal(candidates[0]?.score, 0.82);
  assert.equal(candidates[0]?.recallCount, 3);
  assert.equal(candidates[0]?.uniqueQueries, 2);
});

test("dream promotion parser keeps mismatched, short and annotated fences inside code blocks", () => {
  for (const [opening, falseClosing, closing] of [
    ["````markdown", "```", "````"],
    ["```markdown", "~~~", "```"],
    ["~~~markdown", "```", "~~~~"],
    ["```markdown", "```not a closing fence", "```"],
  ]) {
    const candidates = parseDreamPromotionCandidates([
      "## Deep Sleep",
      opening,
      falseClosing,
      "- Code example {score=0.9 recall=3 unique=2}",
      closing,
      "- Actual candidate {score=0.9 recall=3 unique=2}",
    ].join("\r\n"));

    assert.deepEqual(candidates.map((candidate) => candidate.text), ["Actual candidate"]);
  }
});

test("dream promotion parser recognizes closing heading hashes and top-level section boundaries", () => {
  const candidates = parseDreamPromotionCandidates([
    "## Deep Sleep ##",
    "- Actual candidate {score=0.9 recall=3 unique=2}",
    "# Examples",
    "- Other section {score=0.9 recall=3 unique=2}",
    "## Deep Sleep",
    "##",
    "- Unnamed section {score=0.9 recall=3 unique=2}",
  ].join("\n"));

  assert.deepEqual(candidates.map((candidate) => candidate.text), ["Actual candidate"]);
});

import type { LibravDBClient } from "../../src/libravdb-client.js";

function fakeClient(impl?: { promoteDreamEntries?: (params: unknown) => Promise<unknown> }) {
  return {
    async promoteDreamEntries(params: unknown) {
      return impl?.promoteDreamEntries?.(params) ?? { promoted: 0 };
    },
  } as unknown as LibravDBClient;
}

test("disabled dream promotion does not validate unused diary paths", () => {
  assert.doesNotThrow(() => {
    createDreamPromotionHandle(
      {
        dreamPromotionEnabled: false,
        dreamPromotionDiaryPath: "/etc/passwd",
        dreamPromotionUserId: "fixed-user",
      },
      async () => fakeClient(),
    );
  });
});

test("enabled dream promotion validates configured diary paths", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_STATE_DIR;

  try {
    assert.throws(
      () => createDreamPromotionHandle(
        {
          dreamPromotionEnabled: true,
          dreamPromotionDiaryPath: "/etc/passwd",
          dreamPromotionUserId: "fixed-user",
        },
        async () => fakeClient(),
      ),
      /must be within an allowed root/,
    );
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  }
});

test("dream promotion rejects traversal and paths outside allowed roots", async () => {
  const client = fakeClient();
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_STATE_DIR;

  try {
    await assert.rejects(
      () => promoteDreamDiaryFile(client, {
        userId: "fixed-user",
        diaryPath: `${os.tmpdir()}/../etc/passwd`,
        text: "",
      }),
      /must not contain "\.\." traversal/,
    );

    await assert.rejects(
      () => promoteDreamDiaryFile(client, {
        userId: "fixed-user",
        diaryPath: "/etc/passwd",
        text: "",
      }),
      /must be within an allowed root/,
    );
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  }
});

test("dream promotion accepts explicit diary files under an allowed root", async () => {
  const calls: Array<{ params: unknown }> = [];
  const client = fakeClient({
    promoteDreamEntries: async (params: unknown) => {
      calls.push({ params });
      return { promoted: 1 };
    },
  });
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "libravdb-state-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;

  try {
    const diaryPath = path.join(stateDir, "libravdb-dreams.md");

    await promoteDreamDiaryFile(client, {
      userId: "fixed-user",
      diaryPath,
      text: [
        "## Deep Sleep",
        "- Keep this durable fact {score=0.9 recall=3 unique=2}",
      ].join("\n"),
    });

    assert.equal(calls.length, 1);
    const params = calls[0]?.params as { sourceDoc: string; sourceRoot: string; sourcePath: string };
    assert.equal(params.sourceDoc, path.resolve(diaryPath));
    assert.equal(params.sourceRoot, path.dirname(path.resolve(diaryPath)));
    assert.equal(params.sourcePath, path.basename(diaryPath));
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("normalizeDiaryPath expands ~ to home directory", () => {
  const result = normalizeDiaryPath("~/dreams.md");
  assert.ok(!result.includes("/~/"), `path should not contain literal "~" directory: ${result}`);
  assert.ok(result.includes("/dreams.md"), `path should end with /dreams.md: ${result}`);
});

test("normalizeDiaryPath expands ~subpath correctly", () => {
  const result = normalizeDiaryPath("~/sub/path.md");
  assert.ok(!result.includes("/~/"), `path should not contain literal "~" directory: ${result}`);
  assert.ok(result.endsWith("/sub/path.md"), `path should preserve subpath: ${result}`);
});

test("normalizeDiaryPath rejects .. traversal", () => {
  assert.throws(
    () => normalizeDiaryPath("/tmp/../etc/passwd"),
    /traversal/,
  );
});

test("normalizeDiaryPath rejects paths outside allowed roots", () => {
  assert.throws(
    () => normalizeDiaryPath("/tmp/diary.md"),
    /allowed root/,
  );
});
