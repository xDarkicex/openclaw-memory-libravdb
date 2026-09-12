import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createPluginRuntime } from "../dist/plugin-runtime.js";
import { TranscriptHydration } from "../dist/hydration-transcript.js";
const config = JSON.parse(await fs.readFile(process.env.BENCH_CONFIG, "utf8"));
const runtime = createPluginRuntime(config.plugins.entries["libravdb-memory"].config, { warn() {}, error() {} });
const scope = { tenant: "fixture", session: randomUUID(), audience: "fixture-room" };
const entries = [
  { entryId: "u", message: { role: "user", content: "Investigate why secure client connections failed because the TLS certificate expired." } },
  { entryId: "call", message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "inspect" }] } },
  { entryId: "result", message: { role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "The certificate expired yesterday. Renewing it restored client connections." }] } },
  { entryId: "a", createdAt: "2026-01-01T00:00:00Z", message: { role: "assistant", stopReason: "stop", content: "Renewing the TLS certificate restored secure client connections." } },
  { entryId: "next", message: { role: "user", content: "hello" } },
];
const read = async ({ cursor }) => {
  const i = Number(cursor ?? 0);
  return { kind: "page", cursor: String(i + 1), entries: entries.slice(i, i + 1), hasMore: i + 1 < entries.length };
};
let first, second, client;
try {
  client = await runtime.getClient();
  first = new TranscriptHydration(scope, client, read, s => s);
  await first.refresh(); await first.close();
  second = new TranscriptHydration(scope, client, read, s => s);
  for (const [i, query] of ["hello", "Why did the secure connection fail?", "What repaired our encrypted client connection?"].entries()) {
    const raw = await client.searchText({ collection: first.collection, text: query, k: 3 });
    console.log(JSON.stringify({ diagnosticScores: raw.results.map(r => r.score) }));
    const packet = await second.hydrate(query, String(i), 16000);
    assert.equal(packet.status, "ok");
    if (i === 0) assert.equal(packet.context, "");
    else assert.match(packet.context, /expired yesterday/);
    console.log(JSON.stringify({ query, bytes: Buffer.byteLength(packet.context), frames: packet.selectedIds.length, reads: packet.hydratedIds.length, ms: packet.elapsedMs }));
  }
} finally {
  await second?.close(); await first?.close();
  if (first && client) for (const id of (await client.listCollection({ collection: first.collection })).ids) await client.deleteText({ collection: first.collection, id });
  await runtime.shutdown(); console.log("probe record cleaned");
}
