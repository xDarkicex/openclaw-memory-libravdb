import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerHttp2Session } from "node:http2";
import { LibravDBClient } from "../../src/libravdb-client.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const started = deferred();
  const release = deferred();
  const calls: Array<{ method: string; tenant: string | undefined }> = [];
  const sessions = new Set<ServerHttp2Session>();
  const server = createServer();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => {
    const method = String(headers[":path"]).split("/").at(-1)!;
    calls.push({ method, tenant: headers["libravdb-tenant-key"] as string | undefined });
    stream.on("error", () => {});
    stream.resume();
    stream.on("end", async () => {
      if (method === "SearchTextCollections") {
        started.resolve();
        await release.promise;
      }
      if (stream.destroyed) return;
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      // A valid unary gRPC frame containing the empty protobuf response.
      stream.end(Buffer.alloc(5));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new LibravDBClient({
    endpoint: `tcp:127.0.0.1:${address.port}`,
    tenantKey: "primary",
    secret: "",
    timeoutMs: 2000,
  });
  client.setReadTenants(["read-only-secondary"]);
  t.after(async () => {
    release.resolve();
    client.close();
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { client, started, release, calls };
}

test("a search in a secondary tenant cannot redirect overlapping transcript ingestion", { timeout: 5000 }, async (t) => {
  const { client, started, release, calls } = await fixture(t);
  const search = client.searchTextCollections({ collections: ["global"], text: "recall", k: 5 });
  await started.promise;
  const ingest = client.afterTurnKernel({ sessionId: "primary-session" });
  release.resolve();
  await Promise.all([search, ingest]);
  assert.deepEqual(calls, [
    { method: "SearchTextCollections", tenant: "read-only-secondary" },
    { method: "AfterTurnKernel", tenant: "primary" },
  ]);
});

test("finishing a search cannot roll back a newer primary tenant selection", { timeout: 5000 }, async (t) => {
  const { client, started, release, calls } = await fixture(t);
  const search = client.searchTextCollections({ text: "recall", k: 5 });
  await started.promise;
  client.setTenantKey("new-primary");
  release.resolve();
  await search;
  await client.afterTurnKernel({ sessionId: "new-primary-session" });
  assert.equal(calls.at(-1)?.tenant, "new-primary");
});

test("an in-flight search uses a snapshot of its configured read tenants", { timeout: 5000 }, async (t) => {
  const { client, started, release, calls } = await fixture(t);
  const readTenants = ["first", "second"];
  client.setReadTenants(readTenants);
  const search = client.searchTextCollections({ text: "recall", k: 5 });
  await started.promise;
  readTenants.push("unexpected");
  client.setReadTenants(["replacement"]);
  release.resolve();
  await search;
  assert.deepEqual(calls.map((call) => call.tenant), ["first", "second"]);
});
