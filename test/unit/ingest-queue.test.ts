import test from "node:test";
import assert from "node:assert/strict";

import { IngestMode } from "@xdarkicex/libravdb-contracts";
import { IngestQueue } from "../../src/ingest-queue.js";

const baseParams = {
  tokenizerId: "test-tokenizer",
  coreDoc: false,
  sourceMeta: {
    sourceRoot: "/repo",
    sourcePath: "notes/large.md",
    sourceKind: "test",
    fileHash: "hash",
    sourceSize: 18,
    sourceMtimeMs: 1,
    ingestVersion: 1,
    hashBackend: "test",
  },
};

test("chunked markdown ingest replaces first, then appends remaining chunks", async () => {
  const calls: Array<{ method: string; params: { mode?: IngestMode; text?: string } }> = [];
  const queue = new IngestQueue(
    async <T>(method: string, params: unknown): Promise<T> => {
      calls.push({ method, params: params as { mode?: IngestMode; text?: string } });
      return undefined as T;
    },
    { error() {} },
    { chunkTokens: 1, maxRetries: 0 },
  );

  await queue.enqueueIngest("doc-1", "aaaa bbbb cccc", baseParams);

  assert.ok(calls.length > 1);
  assert.deepEqual(
    calls.map((call) => call.params.mode),
    [IngestMode.REPLACE, ...Array(calls.length - 1).fill(IngestMode.APPEND)],
  );
  assert.equal(calls.map((call) => call.params.text).join(""), "aaaa bbbb cccc");
});
