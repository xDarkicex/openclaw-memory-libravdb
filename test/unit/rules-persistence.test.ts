import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDeleteRuleTool,
  createSetRuleTool,
  getRules,
  initRuleStore,
  scanReply,
  setMaxRules,
  setRule,
} from "../../src/rules.js";

const params = { rule: "Do not reveal the project name", keywords: "secret-project", priority: 5 };

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "libravdb-rule-persistence-"));
  t.after(() => {
    setMaxRules(20);
    rmSync(dir, { recursive: true, force: true });
  });
  initRuleStore(dir);
  setMaxRules(20);
  return { dir, file: join(dir, "rules.json") };
}

test("rule creation and deletion survive a store reload", async (t) => {
  const { dir } = fixture(t);
  const created = await createSetRuleTool().execute("create", params);
  assert.equal(created.details.ok, true);
  initRuleStore(dir);
  assert.deepEqual(getRules(), [created.details.rule]);

  const deleted = await createDeleteRuleTool().execute("delete", { rule_id: created.details.rule!.id });
  assert.equal(deleted.details.ok, true);
  initRuleStore(dir);
  assert.deepEqual(getRules(), []);
  assert.equal(setRule("next rule", ["next"], 5).rule.id, "2");
});

test("failed rule creation reports failure and leaves no volatile rule or consumed ID", async (t) => {
  const { dir, file } = fixture(t);
  mkdirSync(file);
  const result = await createSetRuleTool().execute("create", params);
  assert.equal(result.details.ok, false);
  assert.ok(result.details.error);
  assert.deepEqual(getRules(), []);
  assert.deepEqual(readdirSync(dir), ["rules.json"]);
  rmSync(file, { recursive: true });
  const retry = await createSetRuleTool().execute("retry", params);
  assert.equal(retry.details.ok, true);
  assert.equal(retry.details.rule!.id, "1");
  initRuleStore(dir);
  assert.deepEqual(getRules(), [retry.details.rule]);
});

test("a partial write failure cannot truncate the previously saved rule store", async (t) => {
  const { dir, file } = fixture(t);
  const original = setRule(params.rule, [params.keywords], params.priority).rule;
  const saved = readFileSync(file, "utf8");
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (destination: fs.PathOrFileDescriptor) => {
    write(destination, "{\"rules\":");
    throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
  });
  syncBuiltinESMExports();
  try {
    const result = await createSetRuleTool().execute("create", { ...params, rule: "New rule" });
    assert.equal(result.details.ok, false);
    assert.match(result.details.error ?? "", /No space left/);
    assert.deepEqual(getRules(), [original]);
    assert.equal(readFileSync(file, "utf8"), saved);
    assert.deepEqual(readdirSync(dir), ["rules.json"]);
    initRuleStore(dir);
    assert.deepEqual(getRules(), [original]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

for (const operation of ["replace", "delete"] as const) {
  test(`failed rule ${operation} preserves the acknowledged rule in memory and on disk`, async (t) => {
    const { dir, file } = fixture(t);
    const original = setRule(params.rule, [params.keywords], params.priority).rule;
    const saved = readFileSync(file, "utf8");
    const backup = join(dir, "saved-rules.json");
    renameSync(file, backup);
    mkdirSync(file);
    setMaxRules(1);

    const result = operation === "replace"
      ? await createSetRuleTool().execute("replace", { ...params, rule: "Replacement rule" })
      : await createDeleteRuleTool().execute("delete", { rule_id: original.id });
    assert.equal(result.details.ok, false);
    assert.ok(result.details.error);
    assert.deepEqual(getRules(), [original]);
    assert.equal(scanReply(params.keywords)?.id, original.id);
    assert.equal(readFileSync(backup, "utf8"), saved);
    assert.deepEqual(readdirSync(dir).sort(), ["rules.json", "saved-rules.json"]);

    rmSync(file, { recursive: true });
    renameSync(backup, file);
    initRuleStore(dir);
    assert.deepEqual(getRules(), [original]);

    if (operation === "replace") {
      setMaxRules(1);
      const retry = await createSetRuleTool().execute("retry", { ...params, rule: "Replacement rule" });
      assert.equal(retry.details.ok, true);
      assert.equal(retry.details.replaced, true);
      assert.equal(retry.details.rule!.id, "2");
      initRuleStore(dir);
      assert.deepEqual(getRules(), [retry.details.rule]);
    } else {
      const retry = await createDeleteRuleTool().execute("retry", { rule_id: original.id });
      assert.equal(retry.details.ok, true);
      initRuleStore(dir);
      assert.deepEqual(getRules(), []);
    }
  });
}
