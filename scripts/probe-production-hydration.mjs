import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createPluginRuntime } from "../dist/plugin-runtime.js";
import { TranscriptHydration } from "../dist/hydration-transcript.js";
import { resolveIdentity } from "../dist/identity.js";
import { normalizeKernelContent } from "../dist/context-engine.js";
import { waitForPositiveControl } from "./hydration-probe-control.mjs";
const host = createRequire(process.env.HOST_PACKAGE);
const { readSessionTranscriptVisibleMessageDelta } = await import(pathToFileURL(host.resolve("openclaw/plugin-sdk/session-transcript-runtime")));
const config = JSON.parse(await fs.readFile(process.env.BENCH_CONFIG, "utf8"));
const cfg = config.plugins.entries["libravdb-memory"].config;
const sessions = JSON.parse(await fs.readFile(process.env.SESSIONS_REPORT, "utf8"));
const sessionKey = process.env.PROBE_SESSION_KEY;
if (!sessionKey) throw new Error("PROBE_SESSION_KEY must name an explicit test session");
const session = sessions.sessions.find(s => s.key === sessionKey);
if (!session) throw new Error("No test session selected");
const runtime = createPluginRuntime(cfg, { warn() {}, error() {} });
let adapter;
try {
  const client = await runtime.getClient();
  const identity = resolveIdentity({ configUserId: cfg.userId, identityPath: cfg.identityPath, sessionKey: session.key, noAutoPersist: true });
  adapter = new TranscriptHydration({ tenant: identity.userId, session: session.sessionId, audience: session.key }, client, readSessionTranscriptVisibleMessageDelta, s => normalizeKernelContent(s, { retainOpenClawContext: false }));
  const start = performance.now(); await adapter.refresh();
  console.log(JSON.stringify({ captureMs: performance.now() - start }));
  const result = await adapter.hydrate("hello", "probe-only", 16000);
  console.log(JSON.stringify({ status: result.status, frames: result.selectedIds.length, bytes: Buffer.byteLength(result.context), ms: result.elapsedMs }));
  assert.equal(result.context, "", "Greeting must not hydrate research");
  const { query, ids, obsolete } = await waitForPositiveControl(async (signal) => {
    const listed = await client.listCollection({ collection: adapter.collection }, { signal });
    const obsolete = []; let query;
    for (const id of listed.ids) {
      signal.throwIfAborted();
      const r = await client.listByMeta({ collection: adapter.collection, key: "frameId", value: id }, { signal });
      signal.throwIfAborted();
      const record = r.results[0]; if (!record) continue;
      const meta = JSON.parse(Buffer.from(record.metadataJson).toString());
      const expectedId = createHash("sha256").update(JSON.stringify([meta.anchor?.entryId, meta.terminal?.entryId, meta.anchor?.cursor, meta.terminal?.cursor, meta.terminalDigest])).digest("hex");
      if (id !== expectedId || !meta.frame?.evidence?.some(ref => ref.kind === "tool-result")) obsolete.push(id);
      else query ??= meta.frame.fields?.what?.value;
    }
    if (query) return { query, ids: listed.ids, obsolete };
  });
  let removed = 0;
  for (const id of obsolete) {
    if (process.env.CLEANUP_OLD_HYDRATION === "true") { await client.deleteText({ collection: adapter.collection, id }); removed++; }
  }
  console.log(JSON.stringify({ indexedFrames: ids.length - removed, removedPreflightOnlyFrames: removed }));
  const hit = await adapter.hydrate(query, "probe-positive", 16000);
  console.log(JSON.stringify({ positiveStatus: hit.status, frames: hit.selectedIds.length, reads: hit.hydratedIds.length, bytes: Buffer.byteLength(hit.context), ms: hit.elapsedMs }));
  assert.ok(hit.hydratedIds.length, "Original research evidence must be recovered");
} finally { await adapter?.close(); await runtime.shutdown(); }
