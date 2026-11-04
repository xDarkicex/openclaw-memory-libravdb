import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerHttp2Session } from "node:http2";
import { randomUUID } from "node:crypto";
import { register } from "../../src/index.js";
import { FLUSH_ASYNC_INGESTION, type buildContextEngineFactory } from "../../src/context-engine.js";
import { createPluginRuntime, type ClientGetter } from "../../src/plugin-runtime.js";
import { LibravDBClient } from "../../src/libravdb-client.js";
import type { buildMemoryRuntimeBridge } from "../../src/memory-runtime.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("queued agent writes and tools retain their tenant across another agent's prompt hook", { timeout: 10000 }, async (t) => {
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
    const firstWrite = method === "AfterTurnKernel" && calls.filter(c => c.method === method).length === 1;
    stream.on("error", () => {});
    stream.resume();
    stream.on("end", async () => {
      if (firstWrite) { started.resolve(); await release.promise; }
      if (stream.destroyed) return;
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      stream.end(Buffer.alloc(5));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const hooks = new Map<string, Array<(event: any, ctx: any) => Promise<unknown>>>();
  const tools = new Map<string, (ctx: any) => any>();
  let engine!: ReturnType<typeof buildContextEngineFactory>;
  let bridge!: ReturnType<typeof buildMemoryRuntimeBridge>;
  register({
    registrationMode: "full",
    config: { plugins: { slots: { memory: "libravdb-memory", contextEngine: "libravdb-memory" } } },
    pluginConfig: {
      grpcEndpoint: `tcp:127.0.0.1:${address.port}`, grpcEndpointTlsMode: "insecure", rpcTimeoutMs: 3000,
      userId: "test-user", tenantId: "default-tenant",
      tenantIdByAgent: { a: { primary: "tenant-a", readAccess: ["shared-a"] }, b: "tenant-b", c: "tenant-c" },
    },
    logger: { info() {}, warn() {}, error() {} },
    registerMemoryCapability(_id: string, capability: { runtime: typeof bridge }) { bridge = capability.runtime; },
    registerMemoryEmbeddingProvider() {}, registerCli() {},
    registerContextEngine(_id: string, factory: () => typeof engine) { engine = factory(); },
    registerTool(factory: (ctx: any) => any, opts: { names: string[] }) { tools.set(opts.names[0]!, factory); },
    on(name: string, hook: (event: any, ctx: any) => Promise<unknown>) {
      hooks.set(name, [...(hooks.get(name) ?? []), hook]);
    },
  } as any);
  const runHook = async (name: string, ctx: Record<string, string>) => {
    for (const hook of hooks.get(name) ?? []) await hook({}, ctx);
  };
  t.after(async () => {
    release.resolve();
    await runHook("gateway_stop", {});
    for (const session of sessions) session.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const a = { agentId: "a", sessionKey: "agent:a:main", sessionId: randomUUID() };
  const b = { agentId: "b", sessionKey: "agent:b:main", sessionId: randomUUID() };
  await runHook("before_prompt_build", a);
  const first = { role: "user", content: "First private A turn" };
  await engine.afterTurn({ ...a, messages: [first] });
  await started.promise;
  await engine.afterTurn({ ...a, messages: [first, { role: "assistant", content: "Second private A turn" }] });
  await runHook("before_prompt_build", b);
  release.resolve();
  await engine[FLUSH_ASYNC_INGESTION]();
  assert.deepEqual(calls.filter(c => c.method === "AfterTurnKernel").map(c => c.tenant), ["tenant-a", "tenant-a"]);

  for (const ctx of [a, b, a]) {
    await tools.get("get_user_card")!(ctx).execute("lookup", { user_id: "person" });
  }
  assert.deepEqual(calls.filter(c => c.method === "GetUserCard").map(c => c.tenant), ["tenant-a", "tenant-b", "tenant-a"]);

  // Managers have an agent scope even when the search itself omits it.
  const managerA = (await bridge.getMemorySearchManager({ agentId: "a" })).manager;
  const managerB = (await bridge.getMemorySearchManager({ agentId: "b" })).manager;
  const searchStart = calls.length;
  await managerA.search({ query: "private fact" });
  await managerB.search({ query: "private fact" });
  assert.deepEqual(calls.slice(searchStart).filter(c => c.method === "SearchTextCollections").map(c => c.tenant), ["tenant-a", "shared-a", "tenant-b"]);

  // A fresh engine call can resolve from sessionKey without any prompt hook.
  await engine.compact({ sessionId: randomUUID(), sessionKey: "agent:c:main", force: true });
  // A later callback that omits sessionKey retains this session's binding.
  await engine.compact({ sessionId: a.sessionId, force: true });
  assert.deepEqual(calls.filter(c => c.method === "CompactSession").map(c => c.tenant), ["tenant-c", "tenant-a"]);
  await runHook("session_end", a);
  assert.equal(calls.filter(c => c.method === "SessionLifecycleHint").at(-1)?.tenant, "tenant-a");
  await runHook("gateway_stop", {});
  assert.deepEqual(calls.filter(c => c.method === "Flush").map(c => c.tenant).sort(), ["tenant-a", "tenant-b", "tenant-c"]);
});

test("scoped runtime retries only failed startup and drains every tenant before closing", async (t) => {
  const attempts = new Map<string, number>();
  const closed: string[] = [];
  const flushed: string[] = [];
  const tenant = (client: LibravDBClient) => (client as unknown as { tenantKey: string }).tenantKey;
  t.mock.method(LibravDBClient.prototype, "bootstrapHandshake", async function(this: LibravDBClient) {
    const key = tenant(this);
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
    if (key === "tenant-a" && attempts.get(key) === 1) throw new Error("temporary handshake failure");
  });
  t.mock.method(LibravDBClient.prototype, "flush", async function(this: LibravDBClient) {
    flushed.push(tenant(this));
    if (tenant(this) === "tenant-b") throw new Error("temporary flush failure");
    return {};
  });
  t.mock.method(LibravDBClient.prototype, "close", function(this: LibravDBClient) { closed.push(tenant(this)); });
  const runtime = createPluginRuntime({ tenantId: "default", tenantIdByAgent: { a: "tenant-a", b: "tenant-b" } }, { warn() {}, error() {} });
  const getClient: ClientGetter = runtime.getClient;
  assert.equal(runtime.resolveWriteTenantKey!({ sessionId: "remember-a", sessionKey: "agent:a:main" }), "tenant-a");
  assert.equal(runtime.resolveWriteTenantKey!({ sessionId: "remember-a" }), "tenant-a");
  assert.equal(attempts.size, 0, "checkpoint scope resolution must not start the daemon");
  await assert.rejects(getClient({ agentId: "a" }), /temporary handshake failure/);
  const b = await getClient({ agentId: "b" });
  const [a1, a2] = await Promise.all([getClient({ agentId: "a" }), getClient({ sessionKey: "agent:a:main" })]);
  assert.equal(a1, a2);
  assert.equal(await getClient({ sessionId: "remember-a" }), a1, "checkpoint and client routing share the remembered binding");
  assert.equal(await getClient({ agentId: "b" }), b);
  assert.notEqual(await getClient(), a1, "background services retain the configured default tenant");
  runtime.onShutdown(async () => { assert.equal(await getClient({ agentId: "a" }), a1); });
  await runtime.shutdown();
  assert.deepEqual(flushed.sort(), ["default", "tenant-a", "tenant-b"]);
  assert.deepEqual(closed.sort(), ["default", "tenant-a", "tenant-a", "tenant-b"]);
  assert.deepEqual([...attempts], [["tenant-a", 2], ["tenant-b", 1], ["default", 1]]);
  await assert.rejects(getClient({ agentId: "a" }), /shut down/);
});
