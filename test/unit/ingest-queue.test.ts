import test from "node:test";
import assert from "node:assert/strict";

import { IngestMode } from "@xdarkicex/libravdb-contracts";
import { IngestQueue } from "../../src/ingest-queue.js";

function baseParams() {
  return {
    tokenizerId: "tok-v1",
    coreDoc: true,
    sourceMeta: {
      sourceRoot: "/vault",
      sourcePath: "daily.md",
      sourceKind: "generic",
      fileHash: "abc123",
      sourceSize: 128,
      sourceMtimeMs: 1234,
      sourceCtimeMs: 1234,
      ingestVersion: 1,
      hashBackend: "test",
    },
  };
}

function feedback(overrides: Partial<{
  queueDepth: number;
  queueCapacity: number;
  acceptMore: boolean;
  retryAfterMs: number;
  processingTimeUs: number;
  nodesAccepted: number;
  nodesRejected: number;
  tokensIngested: number;
  tokenBurstLimit: number;
}> = {}) {
  return {
    queueDepth: 0,
    queueCapacity: 10,
    acceptMore: true,
    retryAfterMs: 0,
    processingTimeUs: 1,
    nodesAccepted: 1,
    nodesRejected: 0,
    tokensIngested: 1,
    tokenBurstLimit: 8192,
    ...overrides,
  };
}

test("chunked ingest replaces first chunk then appends remaining chunks", async () => {
  const calls: Array<{ mode?: IngestMode; text: string }> = [];
  const queue = new IngestQueue(
    async (params) => {
      calls.push({ mode: params.mode, text: params.text });
      return { ok: true };
    },
    async () => {},
    { error() {}, warn() {} },
    { chunkTokens: 4, maxRetries: 0 },
  );

  await queue.enqueueIngest(
    "/vault/daily.md",
    [
      "first chunk has enough text to force a split.",
      "second chunk should append instead of replacing prior chunks.",
      "third chunk should append too.",
    ].join("\n\n"),
    baseParams(),
  );

  assert.ok(calls.length > 1, "test input should split into multiple chunks");
  assert.equal(calls[0]?.mode, IngestMode.REPLACE);
  for (const call of calls.slice(1)) {
    assert.equal(call.mode, IngestMode.APPEND);
  }
});

test("chunked ingest does not extend chunks past the configured budget at newline boundaries", async () => {
  for (const text of [
    `${"a".repeat(12)}\n${"b".repeat(10)}`,
    `${"a".repeat(12)}\n\n${"b".repeat(10)}`,
  ]) {
    const calls: Array<{ mode?: IngestMode; text: string }> = [];
    const queue = new IngestQueue(
      async (params) => {
        calls.push({ mode: params.mode, text: params.text });
        return { ok: true };
      },
      async () => {},
      { error() {}, warn() {} },
      { chunkTokens: 3, maxRetries: 0 },
    );

    await queue.enqueueIngest("/vault/daily.md", text, baseParams());

    assert.ok(calls.length > 1, "test input should split into multiple chunks");
    for (const call of calls) {
      assert.ok(call.text.length <= 12, `chunk exceeded maxChars: ${call.text.length}`);
    }
  }
});

test("ok=false ingest responses retry the same chunk before advancing", async () => {
  const calls: Array<{ mode?: IngestMode; text: string }> = [];
  let attempt = 0;
  const queue = new IngestQueue(
    async (params) => {
      calls.push({ mode: params.mode, text: params.text });
      attempt++;
      return attempt === 1
        ? { ok: false }
        : { ok: true, feedback: feedback() };
    },
    async () => {},
    { error() {}, warn() {} },
    { chunkTokens: 4, maxRetries: 1, retryBaseDelayMs: 0 },
  );

  await queue.enqueueIngest(
    "/vault/daily.md",
    [
      "first chunk has enough text to force a split.",
      "second chunk should append instead of replacing prior chunks.",
    ].join("\n\n"),
    baseParams(),
  );

  assert.ok(calls.length > 2, "test input should split after the retried chunk succeeds");
  assert.equal(calls[0]?.mode, IngestMode.REPLACE);
  assert.equal(calls[1]?.mode, IngestMode.REPLACE);
  assert.equal(calls[0]?.text, calls[1]?.text, "retry must not advance the chunk offset");
  for (const call of calls.slice(2)) {
    assert.equal(call.mode, IngestMode.APPEND);
  }
});

test("ok=false ingest responses fail instead of being treated as accepted", async () => {
  const calls: Array<{ mode?: IngestMode; text: string }> = [];
  const queue = new IngestQueue(
    async (params) => {
      calls.push({ mode: params.mode, text: params.text });
      return {
        ok: false,
        feedback: feedback({
          nodesAccepted: 0,
          nodesRejected: 1,
          tokensIngested: 0,
          tokenBurstLimit: 512,
        }),
      };
    },
    async () => {},
    { error() {}, warn() {} },
    { chunkTokens: 4, maxRetries: 1, retryBaseDelayMs: 0 },
  );

  await assert.rejects(
    queue.enqueueIngest(
      "/vault/daily.md",
      [
        "first chunk has enough text to force a split.",
        "second chunk must not be reached if the first chunk is rejected.",
      ].join("\n\n"),
      baseParams(),
    ),
    /returned ok=false/,
  );

  assert.equal(calls.length, 2, "maxRetries=1 should attempt the same rejected chunk twice");
  assert.equal(calls[0]?.mode, IngestMode.REPLACE);
  assert.equal(calls[1]?.mode, IngestMode.REPLACE);
  assert.equal(calls[0]?.text, calls[1]?.text, "rejected chunks must not advance the offset");
});

test("async queue-time nodesAccepted=0 / nodesRejected=0 is success, not a rejection", async () => {
  // The daemon queues asynchronously and returns before commit, so a perfectly
  // good ingest reports nodesAccepted=0, nodesRejected=0 at RPC time. This must
  // NOT be logged as "permanently rejected" (the bug that flooded logs under
  // load) and must not trigger pointless chunk-shrinking.
  const calls: string[] = [];
  const warnings: string[] = [];
  const queue = new IngestQueue(
    async (params) => {
      calls.push(params.text);
      return {
        ok: true,
        feedback: feedback({ nodesAccepted: 0, nodesRejected: 0, tokensIngested: 0, tokenBurstLimit: 512 }),
      };
    },
    async () => {},
    { error() {}, warn(m: string) { warnings.push(String(m)); } },
    { chunkTokens: 8192, maxRetries: 0, retryBaseDelayMs: 0 },
  );

  const doc = "lorem ipsum dolor sit amet ".repeat(2000); // ~54k chars → multiple chunks

  await queue.enqueueIngest("/vault/dense.md", doc, baseParams());

  assert.equal(
    warnings.filter((w) => w.toLowerCase().includes("reject")).length,
    0,
    "async-queued chunks must not produce rejection warnings",
  );
  assert.equal(calls.join(""), doc, "the whole document is submitted contiguously");
});

test("a real rejection (nodesRejected>0) with a lower burst limit shrinks and retries the same offset", async () => {
  const calls: string[] = [];
  let n = 0;
  const queue = new IngestQueue(
    async (params) => {
      calls.push(params.text);
      n += 1;
      // First attempt: a genuine rejection reporting a lower per-chunk limit.
      if (n === 1) {
        return { ok: true, feedback: feedback({ nodesAccepted: 0, nodesRejected: 2, tokenBurstLimit: 256 }) };
      }
      // After shrinking, the smaller chunks queue fine (async, nothing rejected).
      return { ok: true, feedback: feedback({ nodesAccepted: 0, nodesRejected: 0, tokenBurstLimit: 512 }) };
    },
    async () => {},
    { error() {}, warn() {} },
    { chunkTokens: 1024, maxRetries: 0, retryBaseDelayMs: 0 },
  );

  const doc = "x".repeat(8000);

  await queue.enqueueIngest("/d.md", doc, baseParams());

  assert.ok(calls.length >= 2, "should retry after a real rejection");
  assert.ok(calls[1].length < calls[0].length, "the retry shrinks the chunk");
  assert.equal(calls[0].slice(0, calls[1].length), calls[1], "the retry is the same offset, just smaller");
});
