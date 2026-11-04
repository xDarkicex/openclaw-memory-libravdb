import test from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import type { OpenClawPluginApi as InstalledPluginApi } from "../../node_modules/openclaw/dist/plugin-sdk/plugin-entry.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { SummarizeMessagesResponse } from "@xdarkicex/libravdb-contracts";
import { LibravDBClient } from "../../src/libravdb-client.js";
import { register, MEMORY_ID } from "../../src/index.js";

type Provider = Parameters<InstalledPluginApi["registerCompactionProvider"]>[0];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function captureProvider(endpoint = "tcp:127.0.0.1:9") {
  let provider!: Provider;
  let shutdown!: () => Promise<void>;
  register({
    registrationMode: "full", pluginConfig: { userId: "tester", grpcEndpoint: endpoint, rpcTimeoutMs: 5000 },
    config: { plugins: { slots: { memory: MEMORY_ID, contextEngine: MEMORY_ID } } },
    logger: { info() {}, warn() {}, error() {} },
    registerTool() {}, registerContextEngine() {}, registerMemoryCapability() {}, registerService() {},
    registerCompactionProvider(value: Provider) { provider = value; },
    on(event: string, handler: () => Promise<void>) { if (event === "gateway_stop") shutdown = handler; },
  } as unknown as OpenClawPluginApi);
  return { provider, shutdown };
}
async function promptly<T>(promise: Promise<T>, label = "cancellation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle promptly`)), 750);
    })]);
  } finally { clearTimeout(timer); }
}

for (const phase of ["before-start", "during-start"] as const) {
  test(`compaction cancellation ${phase} avoids summarization without canceling shared startup`, async t => {
    const started = deferred();
    const release = deferred();
    let handshakes = 0;
    let summaries = 0;
    t.mock.method(LibravDBClient.prototype, "bootstrapHandshake", async () => { handshakes++; started.resolve(); await release.promise; });
    t.mock.method(LibravDBClient.prototype, "summarizeMessages", async () => { summaries++; return new SummarizeMessagesResponse({ summaryText: "summary" }); });
    t.mock.method(LibravDBClient.prototype, "flush", async () => ({ ok: true }));
    t.mock.method(LibravDBClient.prototype, "close", () => {});
    const { provider, shutdown } = captureProvider();
    const abort = new AbortController();
    const reason = new Error("host canceled compaction");
    if (phase === "before-start") { abort.abort(reason); release.resolve(); }
    const result = provider.summarize({ messages: [], signal: abort.signal }).then(
      value => ({ value, error: undefined }), error => ({ value: undefined, error }),
    );
    try {
      if (phase === "during-start") { await started.promise; abort.abort(reason); }
      const outcome = await promptly(result);
      assert.equal(outcome.error, reason);
      assert.equal(summaries, 0);
      if (phase === "before-start") assert.equal(handshakes, 0);
      release.resolve();
      assert.equal(await provider.summarize({ messages: [] }), "summary");
      assert.equal(handshakes, 1, "a later operation must reuse the shared startup");
      assert.equal(summaries, 1);
    } finally { release.resolve(); await result; await shutdown(); }
  });
}

test("host compaction cancellation resets the active gRPC stream", async t => {
  const savedSecret = process.env.LIBRAVDB_AUTH_SECRET;
  const savedSecretFile = process.env.LIBRAVDB_AUTH_SECRET_FILE;
  delete process.env.LIBRAVDB_AUTH_SECRET;
  delete process.env.LIBRAVDB_AUTH_SECRET_FILE;
  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();
  const started = deferred();
  const closed = deferred();
  server.on("session", session => { sessions.add(session); session.on("close", () => sessions.delete(session)); });
  server.on("stream", (stream, headers) => {
    assert.match(String(headers[":path"]), /SummarizeMessages$/);
    stream.resume();
    stream.on("error", () => {});
    stream.on("close", closed.resolve);
    stream.on("end", started.resolve);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.mock.method(LibravDBClient.prototype, "bootstrapHandshake", async () => {});
  t.mock.method(LibravDBClient.prototype, "flush", async () => ({ ok: true }));
  const { provider, shutdown } = captureProvider(`tcp:127.0.0.1:${(server.address() as AddressInfo).port}`);
  const abort = new AbortController();
  const result = provider.summarize({ messages: [{ role: "user", content: "cancel this work" }], signal: abort.signal }).then(
    value => ({ value, error: undefined }), error => ({ value: undefined, error }),
  );
  try {
    await promptly(started.promise, "request start");
    abort.abort(new Error("host canceled compaction"));
    const outcome = await promptly(result);
    assert.ok(outcome.error, "aborted compaction must reject");
    assert.match(String(outcome.error), /canceled|abort/i);
    await promptly(closed.promise, "stream close");
  } finally {
    for (const session of sessions) session.destroy();
    await result;
    await shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (savedSecret === undefined) delete process.env.LIBRAVDB_AUTH_SECRET; else process.env.LIBRAVDB_AUTH_SECRET = savedSecret;
    if (savedSecretFile === undefined) delete process.env.LIBRAVDB_AUTH_SECRET_FILE; else process.env.LIBRAVDB_AUTH_SECRET_FILE = savedSecretFile;
  }
});
