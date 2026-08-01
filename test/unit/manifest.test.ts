import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TurnManifestStore } from "../../src/manifest.js";

test("manifest store does not create its directory until save", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-manifest-lazy-"));
  const manifestDir = path.join(tempRoot, "manifests");
  const store = new TurnManifestStore(manifestDir);

  assert.equal(fs.existsSync(manifestDir), false);
  store.load("session-a");
  assert.equal(fs.existsSync(manifestDir), false);

  store.save(store.createEmpty("session-a"));
  assert.equal(fs.existsSync(manifestDir), true);
});

test("manifest store keeps lossy-sanitizer session ids in distinct files", async () => {
  const manifestDir = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-manifest-collide-"));
  const store = new TurnManifestStore(manifestDir);
  const slashManifest = store.appendACKedMessages(
    store.createEmpty("session/a"),
    [{ role: "user", content: "slash session" }],
    0,
  );
  const underscoreManifest = store.appendACKedMessages(
    store.createEmpty("session_a"),
    [{ role: "user", content: "underscore session" }],
    0,
  );

  store.save(slashManifest);
  store.save(underscoreManifest);

  assert.equal(store.load("session/a").sessionId, "session/a");
  assert.equal(store.load("session/a").turns[0]?.contentHash, store.hashString("slash session"));
  assert.equal(store.load("session_a").sessionId, "session_a");
  assert.equal(store.load("session_a").turns[0]?.contentHash, store.hashString("underscore session"));
});

test("manifest store rejects a file whose embedded session id does not match", async () => {
  const manifestDir = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-manifest-mismatch-"));
  const store = new TurnManifestStore(manifestDir);
  const warnings: string[] = [];

  store.save(store.appendACKedMessages(
    store.createEmpty("session/a"),
    [{ role: "user", content: "wrong file" }],
    0,
  ));
  await fsp.copyFile(
    path.join(manifestDir, `${store.hashString("session/a")}.manifest.json`),
    path.join(manifestDir, `${store.hashString("session_a")}.manifest.json`),
  );

  const loaded = store.load("session_a", { warn: (message) => warnings.push(message) });

  assert.equal(loaded.sessionId, "session_a");
  assert.equal(loaded.turns.length, 0);
  assert.match(warnings[0] ?? "", /session mismatch/u);
});

test("manifest overlap requires ordered tail-prefix match", () => {
  const store = new TurnManifestStore("/tmp/unused-manifest-test");
  const manifest = store.appendACKedMessages(
    store.createEmpty("session-a"),
    [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ],
    0,
  );

  assert.equal(store.findOverlapIndex(manifest, [
    { role: "user", content: "first" },
    { role: "assistant", content: "second" },
  ]), 2);
  assert.equal(store.findOverlapIndex(manifest, [
    { role: "assistant", content: "second" },
  ]), 0);
});

test("manifest overlap tolerates rotated ids for ordered multi-message matches", () => {
  const store = new TurnManifestStore("/tmp/unused-manifest-test");
  const manifest = store.appendACKedMessages(
    store.createEmpty("session-a"),
    [
      { role: "user", content: "first", id: "synthetic-1" },
      { role: "assistant", content: "second", id: "synthetic-2" },
    ],
    0,
  );

  assert.equal(store.findOverlapIndex(manifest, [
    { role: "user", content: "first", id: "rotated-1" },
    { role: "assistant", content: "second", id: "rotated-2" },
  ]), 2);
});

test("manifest overlap distinguishes single repeated content by message id", () => {
  const store = new TurnManifestStore("/tmp/unused-manifest-test");
  const manifest = store.appendACKedMessages(
    store.createEmpty("session-a"),
    [{ role: "user", content: "ok", id: "turn-1" }],
    0,
  );

  assert.equal(store.findOverlapIndex(manifest, [{ role: "user", content: "ok", id: "turn-1" }]), 1);
  assert.equal(store.findOverlapIndex(manifest, [{ role: "user", content: "ok", id: "turn-2" }]), 0);
  assert.equal(store.findOverlapIndex(manifest, [{ role: "user", content: "ok" }]), 0);
});
