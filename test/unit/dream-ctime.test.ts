import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { createDreamPromotionHandle } from "../../src/dream-promotion.js";
import type { LibravDBClient } from "../../src/libravdb-client.js";

for (const providesCtime of [true, false]) {
  test(`dream watcher detects preserved-mtime rewrites ${providesCtime ? "using ctime" : "without a ctime sentinel"}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let text = "## Deep Sleep\n- Original fact {score=0.9 recall=3 unique=2}\n";
    let revision = 1;
    let notify!: (event: string, file: string) => void;
    const promoted: string[] = [];
    const handle = createDreamPromotionHandle({
      dreamPromotionEnabled: true, dreamPromotionUserId: "u1",
      dreamPromotionDiaryPath: path.join(os.homedir(), "DREAMS.md"), dreamPromotionDebounceMs: 5,
    }, async () => ({
      async promoteDreamEntries(params: { entries: Array<{ text: string }> }) {
        promoted.push(params.entries[0]!.text);
        return { promoted: 1, rejected: 0 };
      },
    }) as unknown as LibravDBClient, { warn() {}, error() {} }, {
      async stat() { return { size: text.length, mtimeMs: 42, ...(providesCtime ? { ctimeMs: revision } : {}) }; },
      async readFile() { return new TextEncoder().encode(text); },
      watch(_dir, callback) { notify = callback; return { close() {}, on() {} }; },
    });
    t.after(() => handle.stop());
    await handle.start();
    t.mock.timers.tick(5);
    await setImmediate();
    assert.deepEqual(promoted, ["Original fact"]);
    const oldSize = text.length;
    text = text.replace("Original", "Replaced");
    assert.equal(text.length, oldSize);
    revision++;
    notify("change", "DREAMS.md");
    t.mock.timers.tick(5);
    await setImmediate();
    assert.deepEqual(promoted, ["Original fact", "Replaced fact"]);
    // A metadata-only change and duplicate event must not resubmit identical text.
    revision++;
    notify("change", "DREAMS.md");
    t.mock.timers.tick(5);
    await setImmediate();
    t.mock.timers.tick(5);
    await setImmediate();
    assert.deepEqual(promoted, ["Original fact", "Replaced fact"]);
  });
}
