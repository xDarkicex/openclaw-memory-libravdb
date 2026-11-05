import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerHttp2Session } from "node:http2";
import { SearchTextResponse, ExpandSummaryRequest, ExpandSummaryResponse } from "@xdarkicex/libravdb-contracts";
import { LibravDBClient } from "../../src/libravdb-client.js";
import { buildMemoryRuntimeBridge } from "../../src/memory-runtime.js";
import { createMemoryDescribeTool, createMemoryExpandTool, createMemoryGrepTool } from "../../src/tools/memory-recall.js";
import { encodeRecordReference } from "../../src/record-reference.js";

async function fixture(t: TestContext, multipleCollections = false, summaries = false) {
  const expansions: Array<{ tenant: string; recordId: string }> = [];
  const summaryExpansions: Array<{ tenant: string; summaryId: string; sessionId: string }> = [];
  const sessions = new Set<ServerHttp2Session>();
  const server = createServer();
  server.on("session", session => { sessions.add(session); session.on("close", () => sessions.delete(session)); });
  server.on("stream", (stream, headers) => {
    const method = String(headers[":path"]).split("/").at(-1)!;
    const tenant = String(headers["libravdb-tenant-key"]);
    const chunks: Buffer[] = [];
    stream.on("error", () => {});
    stream.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("end", () => {
      let response: Uint8Array = new Uint8Array();
      if (method === "SearchTextCollections" || method === "SearchText") {
        const collections = summaries ? ["session_summary:archived/session"] : method === "SearchText" ? ["dream:u1"] : multipleCollections ? ["user:u1", "global", "user:u1"] : ["user:u1"];
        response = new SearchTextResponse({ results: collections.map(collection => ({
          id: "shared/id::%", text: `${tenant} ${collection} record`, score: tenant === "a" ? 0.9 : 0.8,
          metadataJson: new TextEncoder().encode(JSON.stringify({ collection, sourceTenant: "spoofed" })),
        })) }).toBinary();
      } else if (method === "ExpandSummary") {
        const req = ExpandSummaryRequest.fromBinary(Buffer.concat(chunks).subarray(5));
        if (req.summaryId) {
          summaryExpansions.push({ tenant, summaryId: req.summaryId, sessionId: req.sessionId });
          response = new ExpandSummaryResponse({ summaryId: req.summaryId, text: `${tenant} summary`, metadataJson: new TextEncoder().encode(JSON.stringify({
            continuity_lineage: { parent_summary_ids: ["sum_parent"], source_turn_ids: ["source-turn"] },
          })) }).toBinary();
        } else {
          expansions.push({ tenant, recordId: req.recordId });
          response = new ExpandSummaryResponse({ connected: [{ recordId: "child/id", text: `${tenant} child`, depth: 1 }] }).toBinary();
        }
      }
      const frame = Buffer.alloc(5 + response.length);
      frame.writeUInt32BE(response.length, 1);
      frame.set(response, 5);
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      stream.end(frame);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new LibravDBClient({ endpoint: `tcp:127.0.0.1:${address.port}`, tenantKey: "a", secret: "", timeoutMs: 2000 });
  client.setReadTenants(["a", "b"]);
  t.after(async () => {
    client.close();
    for (const session of sessions) session.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const { manager } = await buildMemoryRuntimeBridge(async () => client, { userId: "u1" }).getMemorySearchManager();
  assert.ok(manager);
  const expand = createMemoryExpandTool(async () => client, () => undefined, { warn() {}, error() {} });
  return { client, manager, expand, expansions, summaryExpansions };
}

test("summary search references retain tenant and source session through describe and parent expansion", async t => {
  const { client, manager, expand, summaryExpansions, expansions } = await fixture(t, false, true);
  const hits = await manager.search({ query: "remember this" }) as Array<{ path: string; snippet: string }>;
  const secondary = hits.find(hit => hit.snippet.startsWith("b "))!;
  const describe = createMemoryDescribeTool(async () => client, () => "current-session", { warn() {}, error() {} });
  const described = await describe.execute("describe", { summaryId: secondary.path });
  assert.deepEqual(summaryExpansions, [{ tenant: "b", summaryId: "shared/id::%", sessionId: "archived/session" }]);
  await expand.execute("parent", { summaryIds: described.details.parentSummaryIds, sessionId: "current-session" });
  assert.deepEqual(summaryExpansions[1], { tenant: "b", summaryId: "sum_parent", sessionId: "archived/session" });
  await expand.execute("source", { record_id: described.details.sourceTurnIds![0] });
  assert.deepEqual(expansions[0], { tenant: "b", recordId: "source-turn" });
  for (const reference of ["libravdb://record/b/session_summary%3As/%ZZ", encodeRecordReference("b", "user:u1", "summary"), encodeRecordReference("b", "session_summary:", "summary")]) {
    const invalid = await describe.execute("invalid", { summaryId: reference });
    assert.equal(invalid.details.found, false);
  }
  assert.equal(summaryExpansions.length, 2, "invalid summary references must never reach the daemon");
  client.setReadTenants([]);
  const denied = await describe.execute("denied", { summaryId: secondary.path });
  assert.equal(denied.details.found, false);
  assert.match(denied.details.error!, /outside configured read access/);
  assert.equal(summaryExpansions.length, 2, "revoked references must not be sent to the daemon");
});

test("grep summary IDs preserve their source tenant for describe", async t => {
  const { client, summaryExpansions } = await fixture(t, false, true);
  const grep = createMemoryGrepTool(async () => client, () => "archived/session", { warn() {}, error() {} });
  const describe = createMemoryDescribeTool(async () => client, () => "current-session", { warn() {}, error() {} });
  client.setTenantKey("b");
  const result = await grep.execute("grep", { pattern: "record", scope: "summaries" });
  assert.equal(result.details.summaries.length, 1);
  const ids = result.details.summaries.map(hit => hit.summaryId);
  client.setTenantKey("a");
  for (const id of ids) await describe.execute("describe", { summaryId: id });
  assert.deepEqual(summaryExpansions, [
    { tenant: "b", summaryId: "shared/id::%", sessionId: "archived/session" },
  ]);
});

test("colliding tenant search hits retain exact reads and graph routing through follow-up edges", async t => {
  const { manager, expand, expansions } = await fixture(t);
  const hits = await manager.search({ query: "remember this" }) as Array<{ path: string; snippet: string }>;
  assert.equal(hits.length, 2);
  assert.notEqual(hits[0]!.path, hits[1]!.path);
  for (const hit of hits) assert.equal((await manager.readFile({ relPath: hit.path })).text, hit.snippet);
  const hit = hits.find(hit => hit.snippet.startsWith("b "))!;
  const graph = await expand.execute("graph", { record_id: hit.path });
  assert.deepEqual(expansions, [{ tenant: "b", recordId: "shared/id::%" }]);
  await expand.execute("child", { record_id: graph.details.connected![0]!.recordId });
  assert.deepEqual(expansions[1], { tenant: "b", recordId: "child/id" });
});

test("dream merging retains same-ID hits from different tenants and collections", async t => {
  const { manager } = await fixture(t, true);
  const hits = await manager.search({ query: "recall my dream", k: 10 }) as Array<{ path: string; snippet: string }>;
  assert.equal(hits.length, 5);
  assert.equal(new Set(hits.map(hit => hit.path)).size, 5);
  for (const hit of hits) assert.equal((await manager.readFile({ relPath: hit.path })).text, hit.snippet);
});

test("record references cannot grant tenant access and malformed references never reach the daemon", async t => {
  const { client, manager, expand, expansions } = await fixture(t);
  const hits = await manager.search({ query: "remember this" }) as Array<{ path: string; snippet: string }>;
  const secondary = hits.find(hit => hit.snippet.startsWith("b "))!;
  const forged = encodeRecordReference("not-allowed", "user:u1", "shared/id::%");
  await assert.rejects(manager.readFile({ relPath: forged }), /not returned/);
  const denied = await expand.execute("denied", { record_id: forged });
  assert.match(denied.content[0]!.text, /outside configured read access/);
  client.setReadTenants([]);
  const revoked = await expand.execute("revoked", { record_id: secondary.path });
  assert.match(revoked.content[0]!.text, /outside configured read access/);
  for (const reference of ["libravdb://record/b/memory/%ZZ", "libravdb://record/b/memory", "libravdb://record/b/memory/"]) {
    const malformed = await expand.execute("malformed", { record_id: reference });
    assert.match(malformed.content[0]!.text, /Invalid LibraVDB record reference/);
  }
  assert.equal(expansions.length, 0);
  await expand.execute("legacy", { record_id: "bare-id" });
  assert.deepEqual(expansions, [{ tenant: "a", recordId: "bare-id" }]);
});
