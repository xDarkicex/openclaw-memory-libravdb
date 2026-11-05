import test from "node:test";
import assert from "node:assert/strict";
import { IngestMarkdownDocumentRequest, IngestMode } from "@xdarkicex/libravdb-contracts";
import { IngestQueue } from "../../src/ingest-queue.js";

for (const chunkTokens of [1, 4, 8192, 0.25]) {
  test(`Markdown chunks preserve Unicode through protobuf serialization at budget ${chunkTokens}`, async () => {
    const maxChars = Math.max(2, Math.floor(chunkTokens * 4));
    const source = "x".repeat(maxChars - 1) + "\u{1F9E0}\u{20BB7}".repeat(4) + "\n\nfin é e\u0301";
    const received: string[] = [];
    const modes: Array<IngestMode | undefined> = [];
    const queue = new IngestQueue(
      async (params) => {
        // Concatenating raw JS slices hides split surrogates. Each real RPC
        // serializes independently, replacing an unpaired half with U+FFFD.
        const request = new IngestMarkdownDocumentRequest({ sourceDoc: params.sourceDoc, text: params.text });
        received.push(IngestMarkdownDocumentRequest.fromBinary(request.toBinary()).text);
        modes.push(params.mode);
        return { ok: true };
      },
      async () => {},
      { error() {}, warn() {} },
      { chunkTokens, maxRetries: 0 },
    );
    await queue.enqueueIngest("/vault/unicode.md", source, {
      tokenizerId: "test",
      coreDoc: true,
      sourceMeta: {
        sourceRoot: "/vault",
        sourcePath: "unicode.md",
        sourceKind: "generic",
        fileHash: "fixture",
        sourceSize: Buffer.byteLength(source),
        sourceMtimeMs: 1,
        sourceCtimeMs: 1,
        ingestVersion: 1,
        hashBackend: "test",
      },
    });
    assert.ok(received.length > 1);
    assert.ok(received.join("") === source, "RPC serialization must preserve every Unicode character");
    assert.ok(received.every((chunk) => chunk.length > 0 && chunk.length <= maxChars));
    assert.equal(modes[0], IngestMode.REPLACE);
    assert.ok(modes.slice(1).every((mode) => mode === IngestMode.APPEND));
  });
}
