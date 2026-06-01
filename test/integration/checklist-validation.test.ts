import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();

test("manifest and package metadata satisfy checklist structure", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "openclaw.plugin.json"), "utf8"));
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const hookMd = await readFile(path.join(repoRoot, "HOOK.md"), "utf8");

  assert.deepEqual(manifest.kind, ["memory", "context-engine"]);
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(manifest).sort(),
    ["activation", "configSchema", "contracts", "description", "id", "kind", "name", "version"],
  );
  assert.deepEqual(manifest.activation, { onCommands: ["memory"] });
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual(manifest.contracts.tools, [
    "memory_search",
    "memory_get",
    "memory_describe",
    "memory_expand",
    "memory_grep",
  ]);

  assert.equal(pkg.main, "./dist/index.js");
  assert.equal(pkg.types, "./dist/index.d.ts");
  assert.ok(Array.isArray(pkg.openclaw?.extensions));
  assert.ok(pkg.openclaw.extensions.includes("./dist/index.js"));
  assert.equal(pkg.exports["."].import, "./dist/index.js");
  assert.ok(pkg.files.includes("cli-metadata.js"));
  assert.match(hookMd, /name:\s*libravdb-memory/);
});

test("manifest schema includes runtime-consumed context tuning keys", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "openclaw.plugin.json"), "utf8"));
  const properties = manifest.configSchema.properties as Record<string, { type?: string }>;
  const tuningKeys = [
    "continuityMinTurns",
    "continuityTailBudgetTokens",
    "continuityPriorContextTokens",
    "section7CoarseTopK",
    "section7SecondPassTopK",
    "section7Theta1",
    "section7Kappa",
    "section7HopEta",
    "section7HopThreshold",
    "section7AuthorityRecencyLambda",
    "section7AuthorityRecencyWeight",
    "section7AuthorityFrequencyWeight",
    "section7AuthorityAuthoredWeight",
    "section7AuthoritySalienceWeight",
    "section7RecencyAccessLambda",
    "recoveryFloorScore",
    "recoveryMinTopK",
    "recoveryMinConfidenceMean",
  ];

  for (const key of tuningKeys) {
    assert.equal(properties[key]?.type, "number", `${key} must be accepted by configSchema`);
  }
});

test("manifest schema requires explicit assets for onnx-local embedding setup", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "openclaw.plugin.json"), "utf8"));
  const allOf = manifest.configSchema.allOf as Array<{
    if?: { properties?: Record<string, { const?: string }> };
    then?: { required?: string[] };
  }>;
  const onnxLocalRule = allOf.find((rule) => rule.if?.properties?.embeddingBackend?.const === "onnx-local");

  assert.ok(onnxLocalRule, "onnx-local config rule must exist");
  assert.deepEqual(
    onnxLocalRule.then?.required?.sort(),
    ["embeddingModelPath", "embeddingRuntimePath"],
  );
});

test("manifest schema requires a remote endpoint for remote embedding setup", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "openclaw.plugin.json"), "utf8"));
  const allOf = manifest.configSchema.allOf as Array<{
    if?: { properties?: Record<string, { const?: string }> };
    then?: { required?: string[] };
  }>;
  const remoteRule = allOf.find((rule) => rule.if?.properties?.embeddingBackend?.const === "remote");

  assert.ok(remoteRule, "remote config rule must exist");
  assert.deepEqual(remoteRule.then?.required, ["embeddingEndpoint"]);
});

test("source checklist invariants are present in host code", async () => {
  const indexTs = await readFile(path.join(repoRoot, "src/index.ts"), "utf8");
  const memoryProviderTs = await readFile(path.join(repoRoot, "src/memory-provider.ts"), "utf8");

  assert.match(indexTs, /openclaw\/plugin-sdk\/plugin-entry/);
  assert.match(indexTs, /api\.pluginConfig/);
  assert.match(indexTs, /kind:\s*\["memory",\s*"context-engine"\]/);
  assert.match(indexTs, /export const MEMORY_ID = "libravdb-memory"/);
  assert.match(indexTs, /registerContextEngine\(\s*MEMORY_ID/s);
  assert.match(indexTs, /registerMemoryCapability\(MEMORY_ID/);
  assert.match(indexTs, /registerTool\?\.\(\(ctx\) => memoryTools\.createSearchTool\(ctx\)/);
  assert.match(indexTs, /registerTool\?\.\(\(ctx\) => memoryTools\.createGetTool\(ctx\)/);
  assert.match(indexTs, /api\.config\?\.plugins\?\.slots\?\.memory/);
  assert.match(indexTs, /api\.on\("before_reset"/);
  assert.match(indexTs, /api\.on\("session_end"/);
  assert.match(indexTs, /api\.on\("gateway_stop"/);
  assert.match(indexTs, /registrationMode === "cli-metadata"/);
  assert.doesNotMatch(indexTs, /registerMemoryPromptSection/);
  assert.doesNotMatch(indexTs, /registerMemoryRuntime\?\.\(/);
  assert.doesNotMatch(indexTs, /api\.on\("shutdown"/);
  assert.doesNotMatch(indexTs, /async register\s*\(/);
  assert.match(memoryProviderTs, /availableTools/);
  assert.match(memoryProviderTs, /context-engine assembler/);
});
