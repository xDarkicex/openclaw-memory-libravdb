import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildContextEngineFactory } from "../../src/context-engine.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";

function runtime() {
  let calls = 0;
  const shutdown: Array<() => void | Promise<void>> = [];
  const value: PluginRuntime = {
    async getClient() { calls++; throw new Error("daemon must remain untouched"); },
    onShutdown(task) { shutdown.push(task); },
    async shutdown() { for (const task of shutdown) await task(); },
    async emitLifecycleHint() {},
  };
  return { value, calls: () => calls };
}
const cfg = { userId: "tester", excludeSubagents: true };
const logger = { info() {}, warn() {}, error() {} };

for (const disposeParent of [false, true]) {
  test(`subagent exclusion reaches a separate child engine (parent disposed: ${disposeParent})`, async () => {
    const owner = runtime();
    const parent = buildContextEngineFactory(owner.value, cfg, logger);
    const child = buildContextEngineFactory(owner.value, cfg, logger);
    const childSessionKey = `agent:main:subagent:${randomUUID()}`;
    const handle = await parent.prepareSubagentSpawn({ parentSessionKey: "agent:main:main", childSessionKey });
    if (disposeParent) await parent.dispose();
    const scope = { sessionId: randomUUID(), sessionKey: childSessionKey };
    const messages = [{ role: "user", content: "a complete child task that exceeds the tiny budget", id: "child-user" }];
    try {
      assert.deepEqual(await child.bootstrap(scope), { ok: true });
      await child.ingest({ ...scope, message: messages[0]! });
      const assembled = await child.assemble({ ...scope, messages, tokenBudget: 1 });
      assert.equal(assembled.messages, messages, "exclusion must preserve the untouched host transcript");
      assert.equal(assembled.systemPromptAddition, "");
      await child.afterTurn({ ...scope, messages });
      await child.commitTurn({ ...scope, messages, advancementKey: scope.sessionId });
      await child.compact({ ...scope, force: true });
      assert.equal(owner.calls(), 0);
    } finally {
      handle.rollback?.();
      await child.dispose(); await parent.dispose(); await owner.value.shutdown();
    }
  });
}

test("shared subagent exclusion stays within its runtime and ends on rollback or child completion", async () => {
  const owner = runtime();
  const other = runtime();
  const parent = buildContextEngineFactory(owner.value, cfg, logger);
  const child = buildContextEngineFactory(owner.value, cfg, logger);
  const unrelated = buildContextEngineFactory(other.value, cfg, logger);
  const childSessionKey = `agent:main:subagent:${randomUUID()}`;
  const scope = { sessionId: randomUUID(), sessionKey: childSessionKey };
  try {
    const handle = await parent.prepareSubagentSpawn({ parentSessionKey: "parent", childSessionKey });
    await assert.rejects(unrelated.bootstrap(scope), /daemon must remain untouched/);
    assert.equal(other.calls(), 1, "another runtime must not inherit the marker");
    await child.bootstrap(scope);
    assert.equal(owner.calls(), 0);
    handle.rollback?.();
    await assert.rejects(child.bootstrap(scope), /daemon must remain untouched/);
    assert.equal(owner.calls(), 1);
    await parent.prepareSubagentSpawn({ parentSessionKey: "parent", childSessionKey });
    await child.onSubagentEnded({ childSessionKey, reason: "completed" });
    await assert.rejects(parent.bootstrap(scope), /daemon must remain untouched/);
    assert.equal(owner.calls(), 2, "child completion clears the marker for all engines");
    await parent.prepareSubagentSpawn({ parentSessionKey: "parent", childSessionKey });
    await child.bootstrap(scope);
    assert.equal(owner.calls(), 2);
    await owner.value.shutdown();
    await assert.rejects(child.bootstrap(scope), /daemon must remain untouched/);
    assert.equal(owner.calls(), 3, "terminal runtime cleanup clears shared markers");
  } finally {
    await child.dispose(); await parent.dispose(); await unrelated.dispose();
    await owner.value.shutdown(); await other.value.shutdown();
  }
});
