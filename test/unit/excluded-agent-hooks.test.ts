import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { register, MEMORY_ID } from "../../src/index.js";
import { LibravDBClient } from "../../src/libravdb-client.js";
import { setRule } from "../../src/rules.js";
import { buildMemoryRuntimeBridge } from "../../src/memory-runtime.js";

type Hook = (event: unknown, ctx: unknown) => Promise<unknown>;
function setup(t: TestContext) {
  const cacheDir = mkdtempSync(join(tmpdir(), "excluded-hooks-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const calls: string[] = [];
  t.mock.method(LibravDBClient.prototype, "bootstrapHandshake", async () => { calls.push("start"); });
  t.mock.method(LibravDBClient.prototype, "getUserCard", async () => {
    calls.push("card");
    return { cardJson: JSON.stringify({ card: "Alice likes tea" }) };
  });
  t.mock.method(LibravDBClient.prototype, "sessionLifecycleHint", async () => { calls.push("hint"); });
  t.mock.method(LibravDBClient.prototype, "flush", async () => ({}));
  t.mock.method(LibravDBClient.prototype, "close", () => {});
  const hooks = new Map<string, Hook[]>();
  const factories: Array<Parameters<OpenClawPluginApi["registerTool"]>[0]> = [];
  register({
    registrationMode: "full", cacheDir,
    config: { plugins: { slots: { memory: MEMORY_ID, contextEngine: MEMORY_ID } } },
    pluginConfig: { userId: "tester", excludeAgents: [" voice "], grpcEndpoint: "tcp:127.0.0.1:10001" },
    logger: { info() {}, warn() {}, error() {} },
    registerCli() {}, registerMemoryCapability() {}, registerContextEngine() {},
    registerMemoryEmbeddingProvider() {}, registerService() {}, registerRuntimeLifecycle() {},
    registerTool(factory: Parameters<OpenClawPluginApi["registerTool"]>[0]) { factories.push(factory); },
    on(name: string, hook: Hook) { hooks.set(name, [...(hooks.get(name) ?? []), hook]); },
  } as unknown as OpenClawPluginApi);
  setRule("Always use metric units", [], 5);
  const run = (name: string, event: unknown, ctx: unknown) =>
    Promise.all((hooks.get(name) ?? []).map(hook => hook(event, ctx)));
  t.after(() => run("gateway_stop", {}, {}));
  return { calls, run, factories };
}
const prompt = { messages: [{ role: "user", content: "[12:34] Alice: hello" }] };
const excluded = { agentId: "voice", sessionId: "voice-session", sessionKey: "agent:voice:main", messageProvider: "discord" };

test("excluded prompt hooks neither connect nor inject cards or rules", async t => {
  const { calls, run } = setup(t);
  assert.deepEqual(await run("before_prompt_build", prompt, excluded), [undefined, undefined, undefined]);
  assert.deepEqual(calls, []);
  const allowed = await run("before_prompt_build", prompt, { ...excluded, agentId: "main", sessionKey: "agent:main:main" });
  assert.match(JSON.stringify(allowed), /Alice likes tea/);
  assert.match(JSON.stringify(allowed), /Always use metric units/);
  assert.deepEqual(calls, ["start", "card"]);
});

test("excluded lifecycle hooks skip RPC with event keys and remembered session IDs", async t => {
  const { calls, run } = setup(t);
  await run("before_prompt_build", {}, excluded);
  await run("before_reset", {}, { sessionId: excluded.sessionId });
  await run("session_end", { sessionKey: excluded.sessionKey }, { agentId: "main" });
  await run("session_end", { sessionId: excluded.sessionId }, {});
  assert.deepEqual(calls, []);
  await run("before_reset", {}, { agentId: "main", sessionId: "allowed" });
  assert.deepEqual(calls, ["start", "hint"]);
});

test("agent identity falls back to agentId but an explicit session key takes precedence", async t => {
  const { calls, run } = setup(t);
  assert.deepEqual(await run("before_prompt_build", prompt, { agentId: "voice" }), [undefined, undefined, undefined]);
  assert.deepEqual(calls, []);
  const allowed = await run("before_prompt_build", {}, { agentId: "voice", sessionKey: "agent:main:main" });
  assert.match(JSON.stringify(allowed), /Always use metric units/);
  assert.deepEqual(calls, ["start"]);
});

test("excluded agents receive no memory tool factories, while allowed agents retain all tools", t => {
  const { calls, factories } = setup(t);
  assert.equal(factories.length, 14);
  for (const factory of factories) {
    assert.equal(typeof factory, "function");
    if (typeof factory !== "function") continue;
    assert.equal(factory(excluded), null);
    assert.ok(factory({ agentId: "main", sessionKey: "agent:main:main" }));
  }
  assert.deepEqual(calls, []);
});

test("native memory manager reports excluded agents unavailable before acquiring a client", async () => {
  let connections = 0;
  const bridge = buildMemoryRuntimeBridge(async () => {
    connections++;
    return { status: async () => ({ ok: true }) } as unknown as LibravDBClient;
  }, { excludeAgents: [" voice "] });
  const excludedResult = await bridge.getMemorySearchManager({ agentId: "voice" });
  assert.equal(excludedResult.manager, null);
  assert.equal(connections, 0);
  assert.ok((await bridge.getMemorySearchManager({ agentId: "main" })).manager);
  assert.equal(connections, 1);
});

test("memory tool execution preserves the session key used to resolve agent exclusion", async t => {
  const { factories } = setup(t);
  t.mock.method(LibravDBClient.prototype, "status", async () => ({ ok: true }));
  t.mock.method(LibravDBClient.prototype, "searchTextCollections", async () => ({ results: [] }));
  const tools = factories.flatMap(factory => typeof factory === "function"
    ? factory({ agentId: "voice", sessionKey: "agent:main:main" }) ?? [] : []);
  const search = tools.find(tool => tool.name === "libravdb_memory_search");
  assert.ok(search);
  const result = await search.execute("search-1", { query: "prior work" });
  assert.notEqual((result.details as { disabled?: boolean }).disabled, true);
});
