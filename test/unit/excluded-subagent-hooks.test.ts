import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { register, MEMORY_ID } from "../../src/index.js";
import { LibravDBClient } from "../../src/libravdb-client.js";
import { setRule } from "../../src/rules.js";
import type { buildContextEngineFactory } from "../../src/context-engine.js";

type Hook = (event: unknown, ctx: unknown) => Promise<unknown>;
const child = { agentId: "main", sessionId: "child-session", sessionKey: "agent:main:subagent:child", messageProvider: "discord" };
const parent = { ...child, sessionId: "parent-session", sessionKey: "agent:main:main" };
const prompt = { messages: [{ role: "user", content: "[12:34] Alice: hello" }] };

async function setup(t: TestContext) {
  const cacheDir = mkdtempSync(join(tmpdir(), "excluded-subagent-hooks-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const calls: string[] = [];
  t.mock.method(LibravDBClient.prototype, "bootstrapHandshake", async () => { calls.push("start"); });
  t.mock.method(LibravDBClient.prototype, "getUserCard", async () => { calls.push("card"); return { cardJson: JSON.stringify({ card: "Alice likes tea" }) }; });
  t.mock.method(LibravDBClient.prototype, "sessionLifecycleHint", async () => { calls.push("hint"); });
  t.mock.method(LibravDBClient.prototype, "status", async () => { calls.push("status"); return { ok: true }; });
  t.mock.method(LibravDBClient.prototype, "flush", async () => ({}));
  t.mock.method(LibravDBClient.prototype, "close", () => {});
  const hooks = new Map<string, Hook[]>();
  const factories: Array<Parameters<OpenClawPluginApi["registerTool"]>[0]> = [];
  let createEngine!: () => ReturnType<typeof buildContextEngineFactory>;
  let memoryRuntime!: { getMemorySearchManager(params: { agentId?: string; sessionKey?: string }): Promise<{ manager: unknown; error?: string }> };
  register({
    registrationMode: "full", cacheDir,
    config: { plugins: { slots: { memory: MEMORY_ID, contextEngine: MEMORY_ID } } },
    pluginConfig: { userId: "tester", excludeSubagents: true, grpcEndpoint: "tcp:127.0.0.1:10001" },
    logger: { info() {}, warn() {}, error() {} },
    registerCli() {}, registerMemoryCapability(_id: string, capability: { runtime: typeof memoryRuntime }) { memoryRuntime = capability.runtime; },
    registerContextEngine(_id: string, factory: typeof createEngine) { createEngine = factory; },
    registerMemoryEmbeddingProvider() {}, registerService() {}, registerRuntimeLifecycle() {},
    registerTool(factory: Parameters<OpenClawPluginApi["registerTool"]>[0]) { factories.push(factory); },
    on(name: string, hook: Hook) { hooks.set(name, [...(hooks.get(name) ?? []), hook]); },
  } as unknown as OpenClawPluginApi);
  setRule("Always use metric units", [], 5);
  const engine = createEngine();
  const spawn = await engine.prepareSubagentSpawn({ parentSessionKey: parent.sessionKey, childSessionKey: child.sessionKey });
  await engine.dispose();
  const run = (name: string, event: unknown, ctx: unknown) => Promise.all((hooks.get(name) ?? []).map(hook => hook(event, ctx)));
  t.after(() => run("gateway_stop", {}, {}));
  return { calls, run, factories, memoryRuntime, rollback: spawn?.rollback };
}

test("excluded subagents receive no prompt-hook memory after their parent engine is disposed", async t => {
  const { calls, run } = await setup(t);
  assert.deepEqual(await run("before_prompt_build", prompt, child), [undefined, undefined, undefined]);
  assert.deepEqual(calls, []);
  assert.match(JSON.stringify(await run("before_prompt_build", prompt, parent)), /Alice likes tea/);
  assert.deepEqual(calls, ["start", "card"]);
});

test("excluded subagents receive no memory tools and spawn rollback restores availability", async t => {
  const { calls, factories, rollback } = await setup(t);
  assert.equal(factories.length, 14);
  for (const factory of factories) {
    if (typeof factory !== "function") continue;
    assert.equal(factory(child), null);
    assert.ok(factory(parent));
  }
  await rollback?.();
  for (const factory of factories) if (typeof factory === "function") assert.ok(factory(child));
  assert.deepEqual(calls, []);
});

test("excluded subagent lifecycle hooks stay local with keys or remembered session IDs", async t => {
  const { calls, run } = await setup(t);
  await run("before_prompt_build", {}, child);
  await run("before_reset", {}, { sessionId: child.sessionId });
  await run("session_end", { sessionKey: child.sessionKey, sessionId: child.sessionId }, {});
  assert.deepEqual(calls, []);
  await run("before_reset", {}, parent);
  assert.deepEqual(calls, ["start", "hint"]);
});

test("native memory access with an excluded child session key avoids connecting", async t => {
  const { calls, memoryRuntime } = await setup(t);
  assert.equal((await memoryRuntime.getMemorySearchManager(child)).manager, null);
  assert.deepEqual(calls, []);
  assert.ok((await memoryRuntime.getMemorySearchManager(parent)).manager);
  assert.deepEqual(calls, ["start", "status"]);
});
