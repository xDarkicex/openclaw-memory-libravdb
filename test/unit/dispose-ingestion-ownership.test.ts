import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextEngineFactory, FLUSH_ASYNC_INGESTION } from "../../src/context-engine.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const nextTick = () => new Promise<void>(resolve => setImmediate(resolve));

test("a stuck owned ingestion still respects the disposal deadline", async t => {
  const started = deferred(), release = deferred();
  const warnings: string[] = [];
  const runtime: PluginRuntime = {
    async getClient() { return { async afterTurnKernel() {
      started.resolve(); await release.promise; return { ok: true };
    } } as never; },
    onShutdown() {}, async shutdown() {}, async emitLifecycleHint() {},
  };
  const engine = buildContextEngineFactory(runtime, { userId: "tester" }, { info() {}, warn(message) { warnings.push(message); }, error() {} });
  t.after(async () => {
    release.resolve();
    await engine[FLUSH_ASYNC_INGESTION]();
    t.mock.timers.reset();
    await engine.dispose();
  });
  await engine.afterTurn({ sessionId: randomUUID(), messages: [{ role: "user", content: "stuck owned write" }] });
  await started.promise;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let disposed = false;
  const disposal = engine.dispose().then(() => { disposed = true; });
  t.mock.timers.tick(4999);
  await nextTick();
  assert.equal(disposed, false);
  t.mock.timers.tick(1);
  await disposal;
  assert.equal(disposed, true);
  assert.ok(warnings.some(message => /1 .*ingestion task/.test(message)));
});

for (const hasOwnWork of [false, true]) {
  test(`disposing an engine waits only for its own ingestion (has work: ${hasOwnWork})`, async t => {
    const stateDir = await fsp.mkdtemp(join(tmpdir(), "libravdb-dispose-owner-"));
    const previous = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const ownStarted = deferred(), releaseOwn = deferred(), otherStarted = deferred(), releaseOther = deferred();
    const timeoutSpy = t.mock.method(globalThis, "setTimeout");
    const clearSpy = t.mock.method(globalThis, "clearTimeout");
    const runtime: PluginRuntime = {
      async getClient() { return { async afterTurnKernel(p: { messages: Array<{ content: string }> }) {
        if (p.messages[0]?.content === "own") { ownStarted.resolve(); await releaseOwn.promise; }
        else { otherStarted.resolve(); await releaseOther.promise; }
        return { ok: true };
      } } as never; },
      onShutdown() {}, async shutdown() {}, async emitLifecycleHint() {},
    };
    const logger = { info() {}, warn() {}, error() {} };
    const owner = buildContextEngineFactory(runtime, { userId: "tester" }, logger);
    const other = buildContextEngineFactory(runtime, { userId: "tester" }, logger);
    let disposal: Promise<void> | undefined;
    t.after(async () => {
      releaseOwn.resolve(); releaseOther.resolve();
      await Promise.allSettled([owner[FLUSH_ASYNC_INGESTION](), disposal]);
      await owner.dispose(); await other.dispose();
      for (const call of timeoutSpy.mock.calls) clearTimeout(call.result);
      if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previous;
      await fsp.rm(stateDir, { recursive: true, force: true });
    });
    const sessionId = randomUUID();
    if (hasOwnWork) {
      await owner.afterTurn({ sessionId, messages: [{ role: "user", content: "own", id: "own" }] });
      await ownStarted.promise;
    }
    // Replacement-engine work may be queued behind this engine in the same
    // session. It must not become part of this engine's disposal obligation.
    await other.afterTurn({ sessionId, messages: [{ role: "user", content: "other", id: "other" }] });
    if (!hasOwnWork) await otherStarted.promise;
    let disposed = false;
    disposal = owner.dispose().then(() => { disposed = true; });
    if (hasOwnWork) {
      await nextTick();
      assert.equal(disposed, false, "owned work must still be drained");
      releaseOwn.resolve();
      await otherStarted.promise;
    }
    await nextTick();
    assert.equal(disposed, true, "unrelated ingestion must not hold disposal until its timeout");
    const drainTimers = timeoutSpy.mock.calls.filter(call => call.arguments[1] === 5000);
    assert.equal(drainTimers.length, hasOwnWork ? 1 : 0);
    for (const timer of drainTimers) {
      assert.ok(clearSpy.mock.calls.some(call => call.arguments[0] === timer.result), "a settled drain must clear its process-retaining timer");
    }
  });
}

test("an owned ingestion failure does not end the drain while another owned write is active", async t => {
  const firstStarted = deferred(), secondStarted = deferred(), releaseFirst = deferred(), releaseSecond = deferred();
  const timeoutSpy = t.mock.method(globalThis, "setTimeout");
  const clearSpy = t.mock.method(globalThis, "clearTimeout");
  const runtime: PluginRuntime = {
    async getClient() { return { async afterTurnKernel(p: { messages: Array<{ content: string }> }) {
      if (p.messages[0]?.content === "first") { firstStarted.resolve(); await releaseFirst.promise; throw new Error("write failed"); }
      secondStarted.resolve(); await releaseSecond.promise; return { ok: true };
    } } as never; },
    onShutdown() {}, async shutdown() {}, async emitLifecycleHint() {},
  };
  const engine = buildContextEngineFactory(runtime, { userId: "tester" }, { info() {}, warn() {}, error() {} });
  let disposal: Promise<void> | undefined;
  t.after(async () => {
    releaseFirst.resolve(); releaseSecond.resolve();
    await Promise.allSettled([engine[FLUSH_ASYNC_INGESTION](), disposal]);
    await engine.dispose();
    for (const call of timeoutSpy.mock.calls) clearTimeout(call.result);
  });
  await engine.afterTurn({ sessionId: randomUUID(), messages: [{ role: "user", content: "first" }] });
  await engine.afterTurn({ sessionId: randomUUID(), messages: [{ role: "user", content: "second" }] });
  await Promise.all([firstStarted.promise, secondStarted.promise]);
  let disposed = false;
  disposal = engine.dispose().then(() => { disposed = true; });
  releaseFirst.resolve();
  await nextTick();
  assert.equal(disposed, false, "one rejected write must not abandon the other owned write");
  releaseSecond.resolve();
  await disposal;
  assert.equal(disposed, true);
  const timer = timeoutSpy.mock.calls.find(call => call.arguments[1] === 5000);
  assert.ok(timer);
  assert.ok(clearSpy.mock.calls.some(call => call.arguments[0] === timer.result), "successful drainage clears the deadline timer");
});
