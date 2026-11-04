import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import path from "node:path";
import os from "node:os";
import { createDreamPromotionHandle } from "../../src/dream-promotion.js";
import type { LibravDBClient } from "../../src/libravdb-client.js";

for (const stopBeforeRetry of [false, true]) {
  test(`dream promotion ${stopBeforeRetry ? "discards" : "processes"} an edit queued during a failed RPC${stopBeforeRetry ? " after stop" : ""}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let rejectFirst!: (error: Error) => void;
    const firstRpc = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    let notify!: (event: string, filename: string) => void;
    let revision = 1;
    const calls: Array<{ entries: Array<{ text: string }> }> = [];
    const warnings: string[] = [];
    const diary = () => `## Deep Sleep\n- revision ${revision} {score=0.9 recall=3 unique=2}\n`;
    const client = {
      async promoteDreamEntries(params: typeof calls[number]) {
        calls.push(params);
        if (calls.length === 1) return await firstRpc;
        return { promoted: 1, rejected: 0 };
      },
    } as unknown as LibravDBClient;
    const handle = createDreamPromotionHandle({
      dreamPromotionEnabled: true, dreamPromotionUserId: "u1",
      dreamPromotionDiaryPath: path.join(os.homedir(), "DREAMS.md"), dreamPromotionDebounceMs: 5,
    }, async () => client, { warn(message) { warnings.push(message); }, error() {} }, {
      async stat() { return { size: diary().length, mtimeMs: revision }; },
      async readFile() { return new TextEncoder().encode(diary()); },
      watch(_dir, callback) { notify = callback; return { close() {}, on() {} }; },
    });
    t.after(() => handle.stop());
    await handle.start();
    t.mock.timers.tick(5);
    await setImmediate();
    assert.equal(calls.length, 1);
    revision = 2;
    notify("change", "DREAMS.md");
    rejectFirst(new Error("temporary daemon disconnect"));
    await setImmediate();
    assert.equal(warnings.length, 1);
    if (stopBeforeRetry) await handle.stop();
    t.mock.timers.tick(5);
    await setImmediate();
    assert.equal(calls.length, stopBeforeRetry ? 1 : 2);
    if (!stopBeforeRetry) assert.equal(calls[1]!.entries[0]!.text, "revision 2");
    // A successful refresh consumes the dirty marker; it must not spin forever.
    t.mock.timers.tick(1000);
    await setImmediate();
    assert.equal(calls.length, stopBeforeRetry ? 1 : 2);
  });
}
