import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDreamPromotionHandle } from "../../src/dream-promotion.js";
import { LibravDBClient } from "../../src/libravdb-client.js";
import { register, MEMORY_ID } from "../../src/index.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const diaryPath = path.join(os.homedir(), "DREAMS.md");
const diaryText = "## Deep Sleep\n- Saved fact {score=0.9 recall=3 unique=2}\n";
const config = {
  userId: "u1", tenantId: "shutdown-test",
  dreamPromotionEnabled: true, dreamPromotionUserId: "u1",
  dreamPromotionDiaryPath: diaryPath, dreamPromotionDebounceMs: 5,
};

test("dream stop waits for an active file read and its promotion", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reading = deferred();
  const releaseRead = deferred();
  let stopped = false;
  let promoted = false;
  const handle = createDreamPromotionHandle(config, async () => {
    assert.equal(stopped, false, "the client must remain available while the scan drains");
    return { async promoteDreamEntries() { promoted = true; } } as unknown as LibravDBClient;
  }, { error() {}, warn() {} }, {
    async stat() { return { size: diaryText.length, mtimeMs: 1 }; },
    async readFile() { reading.resolve(); await releaseRead.promise; return new TextEncoder().encode(diaryText); },
    watch() { return { close() {}, on() {} }; },
  });
  let stopping: Promise<void> | undefined;
  try {
    await handle.start();
    t.mock.timers.tick(5);
    await reading.promise;
    stopping = handle.stop().then(() => { stopped = true; });
    await yieldImmediate();
    assert.equal(stopped, false, "stop must not resolve before the active scan");
    releaseRead.resolve();
    await stopping;
    assert.equal(promoted, true);
  } finally {
    releaseRead.resolve();
    await stopping;
    await handle.stop();
    await yieldImmediate();
  }
});

for (const cleanup of ["gateway_stop", "delete"] as const) {
  test(`${cleanup} drains background promotion before flushing and closing the runtime`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const reading = deferred();
    const releaseRead = deferred();
    const events: string[] = [];
    let openedWatchers = 0;
    const readFile = fsp.readFile.bind(fsp);
    const stat = fsp.stat.bind(fsp);
    t.mock.method(fsp, "readFile", async (...args: Parameters<typeof fsp.readFile>) => {
      if (String(args[0]) !== diaryPath) return readFile(...args);
      reading.resolve();
      await releaseRead.promise;
      return Buffer.from(diaryText);
    });
    t.mock.method(fsp, "stat", async (...args: Parameters<typeof fsp.stat>) => {
      if (String(args[0]) !== diaryPath) return stat(...args);
      return { size: diaryText.length, mtimeMs: 1 };
    });
    t.mock.method(fs, "watch", () => {
      openedWatchers++;
      return { close() { events.push("unwatch"); }, on() {} };
    });
    t.mock.method(LibravDBClient.prototype, "bootstrapHandshake", async () => {});
    t.mock.method(LibravDBClient.prototype, "promoteDreamEntries", async () => {
      events.push("promote");
      if (cleanup === "delete") throw new Error("promotion failed while draining");
      return { promoted: 1 };
    });
    t.mock.method(LibravDBClient.prototype, "flush", async () => { events.push("flush"); return { ok: true }; });
    t.mock.method(LibravDBClient.prototype, "close", () => { events.push("close"); });
    const services = new Map<string, { start(ctx: unknown): Promise<void>; stop?(): Promise<void> }>();
    let shutdown!: () => Promise<void>;
    register({
      registrationMode: "full", pluginConfig: config,
      config: { plugins: { slots: { memory: MEMORY_ID, contextEngine: MEMORY_ID } } },
      logger: { error() {}, warn() {}, info() {} },
      registerTool() {}, registerContextEngine() {}, registerMemoryCapability() {},
      registerService(service: { id: string; start(ctx: unknown): Promise<void>; stop?(): Promise<void> }) { services.set(service.id, service); },
      registerRuntimeLifecycle(lifecycle: { cleanup(ctx: unknown): Promise<void> }) {
        if (cleanup === "delete") shutdown = () => lifecycle.cleanup({ reason: "delete" });
      },
      on(event: string, handler: () => Promise<void>) { if (cleanup === "gateway_stop" && event === cleanup) shutdown = handler; },
    } as unknown as OpenClawPluginApi);
    let stopping: Promise<void> | undefined;
    let stopped = false;
    let concurrentStopped = false;
    let concurrentStop: Promise<void> | undefined;
    try {
      await services.get("libravdb-dream-promotion")!.start({});
      t.mock.timers.tick(5);
      await reading.promise;
      stopping = shutdown().then(() => { stopped = true; });
      concurrentStop = shutdown().then(() => { concurrentStopped = true; });
      await yieldImmediate();
      assert.equal(concurrentStopped, false, "concurrent shutdown must join the same drain");
      assert.equal(stopped, false, "runtime shutdown must join background work even before host service.stop");
      assert.ok(openedWatchers > 0);
      assert.deepEqual(events, Array(openedWatchers).fill("unwatch"));
      releaseRead.resolve();
      await stopping;
      await concurrentStop;
      assert.deepEqual(events, [...Array(openedWatchers).fill("unwatch"), "promote", "flush", "close"]);
      t.mock.timers.tick(100);
      await yieldImmediate();
      assert.equal(events.filter(event => event === "promote").length, 1);
    } finally {
      releaseRead.resolve();
      await stopping;
      await concurrentStop;
      for (const service of services.values()) await service.stop?.();
      await yieldImmediate();
    }
  });
}
