import test from "node:test";
import assert from "node:assert/strict";

// Import the real register function from src/index.ts so tests actually
// exercise the production code path.
import {
  register,
  MEMORY_ID,
  shouldShutdownRuntimeForLifecycleCleanup,
} from "../../src/index.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

/** Builds a fake OpenClawPluginApi for register(). */
function makeFakeApi(overrides: {
  registrationMode?: string;
  slotsMemory?: string;
} = {}): OpenClawPluginApi {
  return {
    id: "test-plugin",
    name: "Test",
    description: "",
    source: "test",
    registrationMode: overrides.registrationMode ?? "full",
    config: {
      plugins: {
        slots: {
          memory: overrides.slotsMemory,
        },
      },
    },
    pluginConfig: {},
    logger: {
      error(_msg: string) {},
      warn(_msg: string) {},
      info(_msg: string) {},
    },
    registerMemoryCapability(_id: string, _cap: unknown) {},
    registerContextEngine(_id: string, _factory: () => unknown) {},
    on(_event: string, _handler: unknown) {},
  } as unknown as OpenClawPluginApi;
}

// slot: "libravdb-memory" — no conflict, should not throw
test("slot check — ours: register succeeds", () => {
  const api = makeFakeApi({ slotsMemory: "libravdb-memory" });
  assert.doesNotThrow(() => register(api), "should not throw when slot is libravdb-memory");
});

// slot: another plugin — should throw with slot name in message
test("slot check — other plugin: register throws", () => {
  const api = makeFakeApi({ slotsMemory: "memory-lancedb" });
  assert.throws(
    () => register(api),
    /memory-lancedb/,
    "error message should name the conflicting plugin",
  );
  assert.throws(
    () => register(api),
    /libravdb-memory/,
    "error message should name this plugin",
  );
});

// slot: undefined — nobody owns it, should not throw
test("slot check — unset: register succeeds", () => {
  const api = makeFakeApi({ slotsMemory: undefined });
  assert.doesNotThrow(() => register(api), "should not throw when slot is unset");
});

// slot: "none" — memory disabled, should not throw
test("slot check — 'none': register succeeds", () => {
  const api = makeFakeApi({ slotsMemory: "none" });
  assert.doesNotThrow(() => register(api), "should not throw when slot is 'none'");
});

// registrationMode: "full" — registration proceeds
test("registrationMode gate — 'full' allows registration", () => {
  const api = makeFakeApi({ registrationMode: "full", slotsMemory: "libravdb-memory" });
  assert.doesNotThrow(() => register(api), "full mode should allow registration");
});

// registrationMode: "cli-metadata" — returns early, no throws
test("registrationMode gate — 'cli-metadata' returns early without throwing", () => {
  const api = makeFakeApi({ registrationMode: "cli-metadata", slotsMemory: "memory-lancedb" });
  // In cli-metadata mode, register() returns before the slot check runs.
  // No error should be thrown — mode guard is first.
  assert.doesNotThrow(() => register(api), "cli-metadata mode should return early, slot check never fires");
});

// registrationMode: "setup-only" — returns early, no throws
test("registrationMode gate — 'setup-only' returns early without throwing", () => {
  const api = makeFakeApi({ registrationMode: "setup-only", slotsMemory: "memory-lancedb" });
  assert.doesNotThrow(() => register(api), "setup-only mode should return early");
});

// cli-metadata mode: slot check skipped because mode gate runs first
// This is the key test that validates ordering — in cli-metadata, even a
// conflicting slot does NOT throw because register() exits before the slot check.
test("combined — cli-metadata with conflicting slot: mode gate blocks before slot check", () => {
  const api = makeFakeApi({ registrationMode: "cli-metadata", slotsMemory: "memory-lancedb" });
  let threw = false;
  try {
    register(api);
  } catch {
    threw = true;
  }
  assert.ok(!threw, "no error in cli-metadata even with conflicting slot — mode guard exits first");
});

test("runtime lifecycle cleanup preserves context-engine runtime on disable", () => {
  assert.equal(shouldShutdownRuntimeForLifecycleCleanup("disable"), false);
  assert.equal(shouldShutdownRuntimeForLifecycleCleanup("reset"), false);
  assert.equal(shouldShutdownRuntimeForLifecycleCleanup("delete"), true);
  assert.equal(shouldShutdownRuntimeForLifecycleCleanup("restart"), true);
});
