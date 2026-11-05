import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createDreamPromotionHandle } from "../../src/dream-promotion.js";

test("dream watcher discovers a diary through multiple initially missing ancestors", async () => {
  const ancestor = path.join(os.homedir(), "dream-missing-ancestors");
  const first = path.join(ancestor, "workspace");
  const second = path.join(first, "notes");
  const parent = path.join(second, "memory");
  const diary = path.join(parent, "DREAMS.md");
  const directories = new Set([ancestor]);
  let text = "## Deep Sleep\n- initial entry {score=0.9 recall=3 unique=3}";
  let mtimeMs = 1000;
  const watchers = new Set<{ dir: string; callback: (event: string, filename: string | Buffer | null) => void }>();
  const promotions: string[] = [];
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const fsApi = {
    async stat() { if (!directories.has(parent)) throw missing(); return { size: text.length, mtimeMs }; },
    async readFile() { return new TextEncoder().encode(text); },
    watch(dir: string, callback: (event: string, filename: string | Buffer | null) => void) {
      if (!directories.has(dir)) throw missing();
      const record = { dir, callback };
      watchers.add(record);
      return { on() {}, close() { watchers.delete(record); } };
    },
  };
  function emit(dir: string, name: string) {
    for (const watch of [...watchers]) if (watch.dir === dir) watch.callback("rename", name);
  }
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), "diary watcher must follow newly created ancestors");
  }
  const handle = createDreamPromotionHandle({ dreamPromotionEnabled: true, dreamPromotionUserId: "tester", dreamPromotionDiaryPath: diary, dreamPromotionDebounceMs: 0 }, async () => ({
    async promoteDreamEntries(p: { entries: Array<{ text: string }> }) {
      if (p.entries[0]?.text) promotions.push(p.entries[0].text);
      return {};
    },
  }) as never, { warn() {}, info() {}, error() {} }, fsApi);
  try {
    await handle.start();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(promotions.length, 0);
    directories.add(first);
    emit(ancestor, "workspace");
    await until(() => [...watchers].some(watch => watch.dir === first));
    directories.add(second);
    directories.add(parent);
    emit(first, "notes");
    await until(() => promotions.at(-1) === "initial entry");
    text = "## Deep Sleep\n- later edit {score=0.9 recall=3 unique=3}";
    mtimeMs = 2000;
    emit(parent, "DREAMS.md");
    await until(() => promotions.at(-1) === "later edit");
    directories.delete(parent);
    directories.delete(second);
    emit(second, "notes");
    await until(() => [...watchers].some(watch => watch.dir === first));
    directories.add(second);
    directories.add(parent);
    text = "## Deep Sleep\n- recreated ancestor {score=0.9 recall=3 unique=3}";
    mtimeMs = 3000;
    emit(first, "notes");
    await until(() => promotions.at(-1) === "recreated ancestor");
  } finally {
    await handle.stop();
    assert.equal(watchers.size, 0);
  }
});

for (const initiallyPresent of [true, false]) {
  test(`dream watcher recovers its diary directory (initially present: ${initiallyPresent})`, async () => {
    const grandparent = path.join(os.homedir(), `dream-watch-${initiallyPresent}`);
    const parent = path.join(grandparent, "memory");
    const diary = path.join(parent, "DREAMS.md");
    let present = initiallyPresent;
    let generation = 0;
    let text = "## Deep Sleep\n- original {score=0.9 recall=3 unique=3}";
    let mtimeMs = 1000;
    const watchers = new Set<{ dir: string; generation: number; callback: (event: string, filename: string | Buffer | null) => void }>();
    const promotions: string[] = [];
    const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
    const fsApi = {
      async stat() { if (!present) throw missing(); return { size: text.length, mtimeMs }; },
      async readFile() { if (!present) throw missing(); return new TextEncoder().encode(text); },
      watch(dir: string, callback: (event: string, filename: string | Buffer | null) => void) {
        if (dir === parent && !present) throw missing();
        const record = { dir, generation, callback };
        watchers.add(record);
        return { on() {}, close() { watchers.delete(record); } };
      },
    };
    function emit(dir: string, event: string, filename: string) {
      for (const watch of [...watchers]) {
        if (watch.dir === dir && (dir === grandparent || watch.generation === generation)) watch.callback(event, filename);
      }
    }
    async function until(predicate: () => boolean) {
      for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(predicate(), "diary updates must survive directory creation/replacement");
    }
    const handle = createDreamPromotionHandle({ dreamPromotionEnabled: true, dreamPromotionUserId: "tester", dreamPromotionDiaryPath: diary, dreamPromotionDebounceMs: 0 }, async () => ({
      async promoteDreamEntries(p: { entries: Array<{ text: string }> }) {
        if (p.entries[0]?.text) promotions.push(p.entries[0].text);
        return {};
      },
    }) as never, { warn() {}, info() {}, error() {} }, fsApi);
    try {
      await handle.start();
      if (initiallyPresent) {
        await until(() => promotions.length === 1);
        emit(parent, "rename", path.basename(parent));
      } else {
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(promotions.length, 0);
      }
      present = true;
      generation++;
      text = "## Deep Sleep\n- replacement entry {score=0.9 recall=3 unique=3}";
      mtimeMs = 2000;
      emit(grandparent, "rename", path.basename(parent));
      await until(() => promotions.at(-1) === "replacement entry");
      text = "## Deep Sleep\n- later edit {score=0.9 recall=3 unique=3}";
      mtimeMs = 3000;
      emit(parent, "change", "DREAMS.md");
      await until(() => promotions.at(-1) === "later edit");
    } finally {
      await handle.stop();
      assert.equal(watchers.size, 0);
    }
  });
}
