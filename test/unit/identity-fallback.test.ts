import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { resolveIdentity } from "../../src/identity.js";

for (const homeAvailable of [true, false]) {
  test(`identity survives failed account lookup (home available: ${homeAvailable})`, t => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "libravdb-identity-fallback-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    t.mock.method(os, "userInfo", () => { throw new Error("uv_os_get_passwd returned ENOENT"); });
    t.mock.method(os, "homedir", () => {
      if (!homeAvailable) throw new Error("home directory lookup failed");
      return tempRoot;
    });
    syncBuiltinESMExports();
    try {
      const expectedPath = path.join(tempRoot, ".openclaw", "libravdb-identity.json");
      const readonly = resolveIdentity({ noAutoPersist: true });
      assert.equal(readonly.source, "auto");
      assert.ok(readonly.userId.length > 0);
      assert.equal(fs.existsSync(expectedPath), false);
      if (homeAvailable) {
        const first = resolveIdentity({});
        assert.equal(first.userId, readonly.userId);
        assert.equal(JSON.parse(fs.readFileSync(expectedPath, "utf8")).userId, first.userId);
        assert.deepEqual(resolveIdentity({}), { userId: first.userId, source: "file" });
      } else {
        const write = t.mock.method(fs, "writeFileSync", () => { assert.fail("no home means no implicit persistence path"); });
        syncBuiltinESMExports();
        assert.deepEqual(resolveIdentity({}), readonly);
        assert.equal(write.mock.callCount(), 0);
      }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}
