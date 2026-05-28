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

type InstrumentedApi = OpenClawPluginApi & {
  registrations: {
    memoryCapabilities: string[];
    contextEngines: string[];
    embeddingProviders: string[];
    tools: string[];
    runtimeLifecycles: string[];
    services: string[];
    hooks: string[];
  };
};

/** Builds a fake OpenClawPluginApi for register(). */
function makeFakeApi(overrides: {
  registrationMode?: string;
  slotsMemory?: string;
} = {}): InstrumentedApi {
  const registrations: InstrumentedApi["registrations"] = {
    memoryCapabilities: [],
    contextEngines: [],
    embeddingProviders: [],
    tools: [],
    runtimeLifecycles: [],
    services: [],
    hooks: [],
  };
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
    registerMemoryCapability(id: string, _cap: unknown) {
      registrations.memoryCapabilities.push(id);
    },
    registerTool(tool: unknown, opts?: { name?: string; names?: string[] }) {
      const toolNames = opts?.names ?? (opts?.name ? [opts.name] : []);
      if (toolNames.length > 0) {
        registrations.tools.push(...toolNames);
        return;
      }
      if (tool && typeof tool === "object" && "name" in tool) {
        registrations.tools.push(String((tool as { name: unknown }).name));
      }
    },
    registerContextEngine(id: string, _factory: () => unknown) {
      registrations.contextEngines.push(id);
    },
    registerMemoryEmbeddingProvider(provider: { id?: string }) {
      registrations.embeddingProviders.push(provider.id ?? "");
    },
    registerRuntimeLifecycle(lifecycle: { id?: string }) {
      registrations.runtimeLifecycles.push(lifecycle.id ?? "");
    },
    registerService(service: { id?: string }) {
      registrations.services.push(service.id ?? "");
    },
    on(event: string, _handler: unknown) {
      registrations.hooks.push(event);
    },
    registrations,
  } as unknown as InstrumentedApi;
}

// slot: "libravdb-memory" — no conflict, should not throw
test("slot check — ours: register succeeds", () => {
  const api = makeFakeApi({ slotsMemory: "libravdb-memory" });
  assert.doesNotThrow(() => register(api), "should not throw when slot is libravdb-memory");
  assert.deepEqual(api.registrations.memoryCapabilities, [MEMORY_ID]);
  assert.deepEqual(api.registrations.contextEngines, [MEMORY_ID]);
  assert.deepEqual(api.registrations.embeddingProviders, [
    "libravdb-gguf",
    "libravdb-bundled",
    "libravdb-onnx",
  ]);
  assert.deepEqual(api.registrations.tools, ["memory_search", "memory_get"]);
  assert.deepEqual(api.registrations.services, [
    "libravdb-markdown-ingestion",
    "libravdb-dream-promotion",
  ]);
  assert.deepEqual(api.registrations.runtimeLifecycles, ["libravdb-shutdown"]);
  assert.deepEqual(api.registrations.hooks, [
    "before_reset",
    "session_end",
    "gateway_stop",
  ]);
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

// slot: undefined — nobody owns it, should warn but still register
test("slot check — unset: register succeeds with warning", () => {
  const api = makeFakeApi({ slotsMemory: undefined });
  assert.doesNotThrow(() => register(api), "should not throw when slot is unset");
  assert.deepEqual(api.registrations.memoryCapabilities, [MEMORY_ID]);
  assert.deepEqual(api.registrations.contextEngines, [MEMORY_ID]);
  assert.deepEqual(api.registrations.embeddingProviders, [
    "libravdb-gguf",
    "libravdb-bundled",
    "libravdb-onnx",
  ]);
  assert.deepEqual(api.registrations.tools, []);
  assert.deepEqual(api.registrations.services, [
    "libravdb-markdown-ingestion",
    "libravdb-dream-promotion",
  ]);
  assert.deepEqual(api.registrations.runtimeLifecycles, ["libravdb-shutdown"]);
  assert.deepEqual(api.registrations.hooks, [
    "before_reset",
    "session_end",
    "gateway_stop",
  ]);
});

// slot: "none" — memory disabled, should not throw or register hooks
test("slot check — 'none': register succeeds", () => {
  const api = makeFakeApi({ slotsMemory: "none" });
  assert.doesNotThrow(() => register(api), "should not throw when slot is 'none'");
  assert.deepEqual(api.registrations.memoryCapabilities, []);
  assert.deepEqual(api.registrations.contextEngines, []);
  assert.deepEqual(api.registrations.embeddingProviders, []);
  assert.deepEqual(api.registrations.tools, []);
  assert.deepEqual(api.registrations.services, []);
  assert.deepEqual(api.registrations.runtimeLifecycles, []);
  assert.deepEqual(api.registrations.hooks, []);
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
  assert.equal(shouldShutdownRuntimeForLifecycleCleanup("restart"), false);
  assert.equal(shouldShutdownRuntimeForLifecycleCleanup("delete"), true);
});
