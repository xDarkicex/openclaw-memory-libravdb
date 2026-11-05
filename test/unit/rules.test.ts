import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRulesContext,
  createListRulesTool,
  createSetRuleTool,
  getRules,
  initRuleStore,
  scanReply,
  setMaxRules,
  setRule,
} from "../../src/rules.js";

test("maxRules=0 disables rule creation, injection, and reply scanning without deleting persisted rules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "libravdb-disabled-rules-"));
  try {
    initRuleStore(dir);
    setMaxRules(20);
    setRule("Do not reveal the project name", ["secret-project"], 5);
    const before = readFileSync(join(dir, "rules.json"), "utf8");
    setMaxRules(0);

    assert.deepEqual(getRules(), []);
    assert.equal(buildRulesContext(), null);
    assert.equal(scanReply("secret-project"), null);
    assert.deepEqual((await createListRulesTool().execute()).details, { rules: [], count: 0 });
    const result = await createSetRuleTool().execute("set-disabled", { rule: "new constraint", keywords: "blocked" });
    assert.equal(result.details.ok, false);
    assert.match(result.details.error ?? "", /disabled/);
    assert.equal(readFileSync(join(dir, "rules.json"), "utf8"), before);

    setMaxRules(20);
    assert.equal(getRules().length, 1);
    assert.equal(scanReply("secret-project")?.rule, "Do not reveal the project name");
  } finally {
    setMaxRules(20);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("initializing another rule store resets a previous store's disabled configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "libravdb-reset-rules-"));
  try {
    setMaxRules(0);
    initRuleStore(dir);
    setRule("active constraint", ["blocked"], 5);

    assert.equal(getRules().length, 1);
    assert.equal(scanReply("blocked")?.rule, "active constraint");
  } finally {
    setMaxRules(20);
    rmSync(dir, { recursive: true, force: true });
  }
});
