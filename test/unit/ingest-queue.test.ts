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
