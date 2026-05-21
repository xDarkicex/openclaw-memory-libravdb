import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMarkdownIngestionHandle, type MarkdownIngestionHandle } from "../../src/markdown-ingest.js";

function createTestFsApi() {
  return {
    readdir: async (dir: string) => fsp.readdir(dir, { withFileTypes: true }),
    readFile: async (file: string) => fsp.readFile(file),
    stat: async (file: string) => {
      const s = await fsp.stat(file);
      return { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
    },
    watch: (_dir: string, _onChange: (event: string, filename: string | Buffer | null) => void) => {
      return {
        close: () => {},
        on: () => {},
      };
    },
    openReadStream: async (file: string) => {
      const handle = await fsp.open(file, "r");
      return {
        read: async (buffer: Uint8Array) => {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          return { bytesRead };
        },
        close: async () => {
          await handle.close();
        },
      };
    },
  };
}

class FeedbackRpcClient {
  calls: Array<{ method: string; params: unknown }> = [];
  private ingestCount = 0;

  constructor(
    private readonly feedbacks: Array<{ acceptMore: boolean; retryAfterMs: number; tokensIngested: number } | undefined>,
  ) {}

  async ingestMarkdownDocument(_params: unknown): Promise<{ ok: boolean; feedback?: { acceptMore: boolean; retryAfterMs: number; tokensIngested: number } }> {
    this.calls.push({ method: "ingest_markdown_document", params: _params });
    const feedback = this.feedbacks[this.ingestCount];
    this.ingestCount++;
    if (feedback !== undefined) {
      return { ok: true, feedback };
    }
    return { ok: true };
  }

  async deleteAuthoredDocument(params: { sourceDoc: string }): Promise<{ ok: boolean }> {
    this.calls.push({ method: "delete_authored_document", params });
    return { ok: true };
  }
}

test("stops scanning when daemon returns acceptMore: false", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-feedback-stop-"));
  let handle: MarkdownIngestionHandle | undefined;
  try {
    await fsp.writeFile(path.join(tempRoot, "a.md"), "# File A\n\nContent for file A.");
    await fsp.writeFile(path.join(tempRoot, "b.md"), "# File B\n\nContent for file B.");
    await fsp.writeFile(path.join(tempRoot, "c.md"), "# File C\n\nContent for file C.");

    const feedbacks = [
      { acceptMore: false, retryAfterMs: 2000, tokensIngested: 100 },
    ];
    const rpc = new FeedbackRpcClient(feedbacks);
    handle = createMarkdownIngestionHandle(
      {
        markdownIngestionEnabled: true,
        markdownIngestionRoots: [tempRoot],
        markdownIngestionDebounceMs: 0,
        markdownIngestionSnapshotPath: path.join(tempRoot, "snapshot.json"),
        markdownIngestionMaxTokensPerFile: 128_000,
      },
      async () => rpc as never,
      { error() {}, warn() {}, info() {} },
      createTestFsApi() as never,
    );

    await handle.start();

    const ingestCalls = rpc.calls.filter((c) => c.method === "ingest_markdown_document");
    assert.equal(
      ingestCalls.length,
      1,
      `expected 1 ingest call when daemon says stop, got ${ingestCalls.length}`,
    );
  } finally {
    await handle?.stop();
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test("continues scanning when daemon returns no feedback", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-feedback-continue-"));
  let handle: MarkdownIngestionHandle | undefined;
  try {
    await fsp.writeFile(path.join(tempRoot, "a.md"), "# File A\n\nContent for file A.");
    await fsp.writeFile(path.join(tempRoot, "b.md"), "# File B\n\nContent for file B.");
    await fsp.writeFile(path.join(tempRoot, "c.md"), "# File C\n\nContent for file C.");

    const feedbacks: Array<undefined> = [undefined, undefined, undefined];
    const rpc = new FeedbackRpcClient(feedbacks);
    handle = createMarkdownIngestionHandle(
      {
        markdownIngestionEnabled: true,
        markdownIngestionRoots: [tempRoot],
        markdownIngestionDebounceMs: 0,
        markdownIngestionSnapshotPath: path.join(tempRoot, "snapshot.json"),
        markdownIngestionMaxTokensPerFile: 128_000,
      },
      async () => rpc as never,
      { error() {}, warn() {}, info() {} },
      createTestFsApi() as never,
    );

    await handle.start();

    const ingestCalls = rpc.calls.filter((c) => c.method === "ingest_markdown_document");
    assert.equal(
      ingestCalls.length,
      3,
      `expected 3 ingest calls with no feedback, got ${ingestCalls.length}`,
    );
  } finally {
    await handle?.stop();
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});
