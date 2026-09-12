import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createPluginRuntime } from "../dist/plugin-runtime.js";

const config = JSON.parse(await fs.readFile(process.env.BENCH_CONFIG, "utf8"));
const runtime = createPluginRuntime(config.plugins.entries["libravdb-memory"].config, { warn() {}, error() {} });
const collection = `hydration-probe-${randomUUID()}`;
const entries = [
  ["tls", "Secure client connections failed because the TLS certificate expired. Renewing the certificate restored connections."],
  ["printer", "The office printer stopped feeding paper. Removing the paper jam restored printing."],
  ["cache", "Increasing the prompt cache capacity improved model response latency."],
];
let client;
try {
  client = await runtime.getClient();
  const ensured = await client.ensureCollections({ collections: [collection] });
  if (!ensured.ok) throw new Error("Collection creation rejected");
  for (const [id, text] of entries) {
    const result = await client.insertText({ collection, id, text, metadataJson: Buffer.from(JSON.stringify({ source: "synthetic-hydration-probe" })) });
    if (!result.ok) throw new Error("Index insertion rejected");
  }
  for (const text of ["hello", "Why did the secure connection fail?", "What repaired our encrypted client connection?", "How was the printer repaired?"]) {
    const start = performance.now();
    const result = await client.searchText({ collection, text, k: 3 }, { timeoutMs: 5000 });
    console.log(JSON.stringify({ query: text, ms: performance.now() - start, results: result.results.map(r => ({ id: r.id, score: r.score })) }));
  }
} finally {
  try {
    if (client) for (const [id] of entries) await client.deleteText({ collection, id });
    console.log(JSON.stringify({ cleanup: "probe entries deleted", collection }));
  } finally { await runtime.shutdown(); }
}
