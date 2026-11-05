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

test("shared-client queues order deletion after all chunks without blocking other documents", { timeout: 3000 }, async () => {
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const documents = new Map<string, string>();
  let deleted = false;
  let first = true;
  const scope = {};
  const makeQueue = () => new IngestQueue(async params => {
    documents.set(params.sourceDoc, params.mode === IngestMode.APPEND
      ? (documents.get(params.sourceDoc) ?? "") + params.text : params.text);
    if (params.sourceDoc === "shared" && first) {
      first = false;
      started();
      await blocked;
    }
    return { ok: true };
  }, async ({ sourceDoc }) => { deleted = true; documents.delete(sourceDoc); },
  { error() {} }, { chunkTokens: 4, maxRetries: 0 }, scope);
  const firstQueue = makeQueue();
  const secondQueue = makeQueue();
  const ingest = firstQueue.enqueueIngest("shared", "x".repeat(100), baseParams());
  await ready;
  const deletion = secondQueue.enqueueDelete("shared");
  try {
    await secondQueue.enqueueIngest("other", "independent", baseParams());
    assert.equal(documents.get("other"), "independent");
    assert.equal(deleted, false, "deletion must wait for the entire replacement");
  } finally { release(); }
  await Promise.all([ingest, deletion]);
  assert.equal(documents.has("shared"), false, "a late APPEND must not resurrect a deleted document");
});

test("a failed replacement does not poison the next queued update", async () => {
  const calls: string[] = [];
  const queue = new IngestQueue(async params => {
    calls.push(params.text);
    if (params.text === "failure") throw new Error("daemon disconnected");
    return { ok: true };
  }, async () => {}, { error() {} }, { maxRetries: 0 });
  const failed = queue.enqueueIngest("shared", "failure", baseParams());
  const next = queue.enqueueIngest("shared", "replacement", baseParams());
  await assert.rejects(failed, /daemon disconnected/);
  await next;
  assert.deepEqual(calls, ["failure", "replacement"]);
});

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

test("empty ingest deletes the previous authored document in every chunking mode", async () => {
  for (const chunkTokens of [4, Infinity]) {
    const deleted: string[] = [];
    let ingested = false;
    const queue = new IngestQueue(
      async () => { ingested = true; return { ok: true }; },
      async ({ sourceDoc }) => { deleted.push(sourceDoc); },
      { error() {}, warn() {} },
      { chunkTokens, maxRetries: 0 },
    );

    assert.equal(await queue.enqueueIngest("/vault/daily.md", "", baseParams()), undefined);
    assert.deepEqual(deleted, ["/vault/daily.md"]);
    assert.equal(ingested, false);
  }
});

test("empty ingest fails when clearing the previous document fails", async () => {
  const queue = new IngestQueue(
    async () => ({ ok: true }),
    async () => { throw new Error("delete unavailable"); },
    { error() {}, warn() {} },
    { maxRetries: 0 },
  );

  await assert.rejects(queue.enqueueIngest("/vault/daily.md", "", baseParams()), /delete unavailable/);
});

test("ok=false delete responses retry and fail rather than retiring the document", async () => {
  const calls: string[] = [];
  const queue = new IngestQueue(
    async () => ({ ok: true }),
    async ({ sourceDoc }) => { calls.push(sourceDoc); return { ok: false }; },
    { error() {}, warn() {} },
    { maxRetries: 1, retryBaseDelayMs: 0 },
  );

  await assert.rejects(queue.enqueueDelete("/vault/daily.md"), /returned ok=false/);
  assert.deepEqual(calls, ["/vault/daily.md", "/vault/daily.md"]);
});

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

for (const chunkTokens of [4, Infinity]) {
  test(`explicit rejected nodes fail ingestion with chunkTokens=${chunkTokens}`, async () => {
    const calls: string[] = [];
    const acceptedFeedback: unknown[] = [];
    const queue = new IngestQueue(
      async (params) => {
        calls.push(params.text);
        return { ok: true, feedback: feedback({ nodesAccepted: 0, nodesRejected: 1, tokenBurstLimit: 0 }) };
      },
      async () => {},
      { error() {}, warn() {} },
      { chunkTokens, maxRetries: 0, onChunkFeedback: (value) => acceptedFeedback.push(value) },
    );
    await assert.rejects(
      queue.enqueueIngest("/vault/rejected.md", "x".repeat(40), baseParams()),
      /rejected.*nodesRejected=1/i,
    );
    assert.equal(calls.length, 1, "must not advance beyond a rejected chunk");
    assert.deepEqual(acceptedFeedback, [], "rejected feedback must not be reported as an accepted chunk");
  });
}

test("a rejected append stops the document instead of continuing past a missing section", async () => {
  const calls: Array<{ mode?: IngestMode; text: string }> = [];
  const queue = new IngestQueue(
    async (params) => {
      calls.push(params);
      return { ok: true, feedback: feedback({ nodesRejected: calls.length === 2 ? 1 : 0, tokenBurstLimit: 4 }) };
    },
    async () => {},
    { error() {}, warn() {} },
    { chunkTokens: 4, maxRetries: 0 },
  );
  await assert.rejects(queue.enqueueIngest("/vault/rejected.md", "x".repeat(60), baseParams()), /rejected/i);
  assert.deepEqual(calls.map((call) => call.mode), [IngestMode.REPLACE, IngestMode.APPEND]);
});

test("partial acceptance fails without replaying accepted nodes at a smaller burst limit", async () => {
  let calls = 0;
  const queue = new IngestQueue(
    async () => {
      calls++;
      return { ok: true, feedback: feedback({ nodesAccepted: 1, nodesRejected: 1, tokenBurstLimit: 2 }) };
    },
    async () => {},
    { error() {}, warn() {} },
    { chunkTokens: 4, maxRetries: 0 },
  );
  await assert.rejects(queue.enqueueIngest("/vault/partial.md", "x".repeat(40), baseParams()), /rejected/i);
  assert.equal(calls, 1, "a partially accepted chunk must not be replayed as an append");
});
