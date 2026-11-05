import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { createDreamPromotionHandle } from "../../src/dream-promotion.js";
import type { LibravDBClient } from "../../src/libravdb-client.js";

for (const stage of ["stat", "read", "startup"] as const) {
  test(`dream diary deletion reconciles stale entries (${stage}) without treating read errors as deletion`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let errorCode: string | undefined = stage === "startup" ? "ENOENT" : undefined;
    let mtime = 1;
    let durableEntries = ["previously promoted fact"];
    const updates: Array<{ sourceDoc: string; entries: Array<{ text: string }> }> = [];
    const text = "## Deep Sleep\n- Saved fact {score=0.9 recall=3 unique=2}\n";
    const diaryPath = path.join(os.homedir(), "DREAMS.md");
    const handle = createDreamPromotionHandle({
      dreamPromotionEnabled: true, dreamPromotionUserId: "u1",
      dreamPromotionDiaryPath: diaryPath, dreamPromotionDebounceMs: 5,
    }, async () => ({
      async promoteDreamEntries(params: typeof updates[number]) {
        updates.push(params);
        durableEntries = params.entries.map(entry => entry.text);
        return { promoted: params.entries.length };
      },
    } as unknown as LibravDBClient), { error() {}, warn() {} }, {
      async stat() {
        if (errorCode && stage !== "read") throw Object.assign(new Error(errorCode), { code: errorCode });
        return { size: text.length, mtimeMs: mtime };
      },
      async readFile() {
        if (errorCode) throw Object.assign(new Error(errorCode), { code: errorCode });
        return new TextEncoder().encode(text);
      },
      watch() { return { close() {}, on() {} }; },
    });
    const scan = async () => { await handle.refresh(); t.mock.timers.tick(5); await yieldImmediate(); };
    try {
      await handle.start();
      t.mock.timers.tick(5);
      await yieldImmediate();
      if (stage !== "startup") {
        assert.deepEqual(durableEntries, ["Saved fact"]);
        errorCode = "EACCES";
        mtime++;
        await scan();
        assert.deepEqual(durableEntries, ["Saved fact"], "temporary access errors must retain promoted entries");
        assert.equal(updates.length, 1);
        errorCode = "ENOENT";
        await scan();
      }
      assert.deepEqual(durableEntries, [], "confirmed source deletion must reconcile the daemon");
      assert.equal(updates.at(-1)?.sourceDoc, diaryPath);
      const clearedCount = updates.length;
      await scan();
      assert.equal(updates.length, clearedCount, "repeated absence should not send redundant reconciliation RPCs");
      errorCode = undefined;
      mtime = 1;
      await scan();
      assert.deepEqual(durableEntries, ["Saved fact"], "recreating the same source must restore its entries");
    } finally {
      await handle.stop();
    }
  });
}

test("failed missing-diary reconciliation remains retryable", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  let durableEntries = ["old dream"];
  const handle = createDreamPromotionHandle({
    dreamPromotionEnabled: true, dreamPromotionUserId: "u1",
    dreamPromotionDiaryPath: path.join(os.homedir(), "DREAMS.md"), dreamPromotionDebounceMs: 5,
  }, async () => ({
    async promoteDreamEntries(params: { entries: Array<{ text: string }> }) {
      if (++attempts === 1) throw new Error("temporary RPC failure");
      durableEntries = params.entries.map(entry => entry.text);
      return { promoted: 0 };
    },
  } as unknown as LibravDBClient), { error() {}, warn() {} }, {
    async stat() { throw Object.assign(new Error("missing diary"), { code: "ENOENT" }); },
    async readFile() { assert.fail("missing files must not be read"); },
    watch() { return { close() {}, on() {} }; },
  });
  try {
    await handle.start();
    t.mock.timers.tick(5);
    await yieldImmediate();
    assert.equal(attempts, 1);
    assert.deepEqual(durableEntries, ["old dream"]);
    await handle.refresh();
    t.mock.timers.tick(5);
    await yieldImmediate();
    assert.equal(attempts, 2);
    assert.deepEqual(durableEntries, []);
  } finally {
    await handle.stop();
  }
});
