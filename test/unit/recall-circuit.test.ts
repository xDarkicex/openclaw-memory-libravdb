import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildContextEngineFactory } from "../../src/context-engine.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";

function createFixture(code: number) {
  let fail = true;
  let recallCalls = 0;
  let assemblyCalls = 0;
  let turn = 0;
  const client = {
    async beforeTurnKernel() {
      recallCalls++;
      if (fail) throw Object.assign(new Error("recall RPC failed"), { code });
      return { ok: true, predictions: [] };
    },
    async assembleContextInternal() {
      assemblyCalls++;
      return { messages: [], estimatedTokens: 0, systemPromptAddition: "" };
    },
    async getUserCard() { return { cardJson: "" }; },
    async searchTextCollections() { return { results: [] }; },
  };
  const runtime: PluginRuntime = { getClient: async () => client as never, onShutdown() {}, async shutdown() {}, async emitLifecycleHint() {} };
  const engine = buildContextEngineFactory(runtime, {
    userId: "circuit-test", compactThreshold: 1_000_000,
    beforeTurnTimeoutMs: 1000, assembleTimeoutMs: 1000,
  }, { info() {}, warn() {}, error() {} });
  const sessionId = randomUUID();
  return {
    engine,
    setFailure(value: boolean) { fail = value; },
    get recallCalls() { return recallCalls; },
    get assemblyCalls() { return assemblyCalls; },
    async assemble() {
      turn++;
      return engine.assemble({ sessionId, messages: [
        { role: "user", content: `Question ${turn}`, id: `user-${turn}` },
      ], prompt: `Question ${turn}`, tokenBudget: 4000 });
    },
  };
}

for (const [label, code, threshold, cooldown] of [
  ["timeouts", 4, 3, 15_000],
  ["unavailable", 14, 2, 20_000],
  ["unknown errors", 13, 3, 60_000],
  ["overload", 8, 1, 30_000],
  ["authentication", 16, 1, Infinity],
] as const) {
  test(`sequential ${label} open the recall circuit and preserve prompt assembly`, async t => {
    let now = 1_000_000;
    t.mock.method(Date, "now", () => now);
    const fixture = createFixture(code);
    t.after(() => fixture.engine.dispose());
    for (let i = 0; i < threshold; i++) await fixture.assemble();
    assert.equal(fixture.recallCalls, threshold);
    await fixture.assemble();
    assert.equal(fixture.recallCalls, threshold, "another user turn must respect the failure cooldown");
    assert.equal(fixture.assemblyCalls, threshold + 1, "ordinary prompt assembly must continue");
    if (cooldown === Infinity) {
      now += 1_000_000;
      await fixture.assemble();
      assert.equal(fixture.recallCalls, threshold);
    } else {
      now += cooldown - 1;
      await fixture.assemble();
      assert.equal(fixture.recallCalls, threshold);
      now += 2;
      fixture.setFailure(false);
      await fixture.assemble();
      await fixture.assemble();
      assert.equal(fixture.recallCalls, threshold + 2, "recall must recover after cooldown and remain usable");
    }
  });
}

test("a successful recall resets the consecutive failure count", async t => {
  const fixture = createFixture(14);
  t.after(() => fixture.engine.dispose());
  await fixture.assemble();
  fixture.setFailure(false);
  await fixture.assemble();
  fixture.setFailure(true);
  await fixture.assemble();
  await fixture.assemble();
  assert.equal(fixture.recallCalls, 4, "success must break the failure sequence");
  await fixture.assemble();
  assert.equal(fixture.recallCalls, 4, "the subsequent two failures must still open the circuit");
});
