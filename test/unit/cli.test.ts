import test from "node:test";
import assert from "node:assert/strict";

import { registerMemoryCli } from "../../src/cli.js";
import { registerMemoryCliMetadata } from "../../src/cli-descriptors.js";
import { register } from "../../src/index.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";
import type { PluginConfig } from "../../src/types.js";

type RegisteredCli = {
  builder: (ctx: { program: FakeCommand }) => void;
  opts?: {
    descriptors?: Array<{
      name: string;
      description: string;
      hasSubcommands: boolean;
    }>;
  };
};

class FakeCommand {
  public commands: FakeCommand[] = [];
  public descriptions: string[] = [];
  public options: string[] = [];
  public requiredOptions: string[] = [];
  public arguments: string[] = [];
  public handler: ((...args: unknown[]) => unknown) | null = null;

  constructor(private readonly commandName: string) {}

  command(name: string): FakeCommand {
    const child = new FakeCommand(name);
    this.commands.push(child);
    return child;
  }

  description(text: string): FakeCommand {
    this.descriptions.push(text);
    return this;
  }

  argument(name: string): FakeCommand {
    this.arguments.push(name);
    return this;
  }

  option(flags: string): FakeCommand {
    this.options.push(flags);
    return this;
  }

  requiredOption(flags: string): FakeCommand {
    this.options.push(flags);
    this.requiredOptions.push(flags);
    return this;
  }

  action(handler: (...args: unknown[]) => unknown): FakeCommand {
    this.handler = handler;
    return this;
  }

  name(): string {
    return this.commandName;
  }
}

const selectedConfig = {
  plugins: {
    slots: {
      memory: "libravdb-memory",
      contextEngine: "libravdb-memory",
    },
  },
};

function createRuntime(): PluginRuntime {
  return {
    async getRpc() {
      throw new Error("not used by registration tests");
    },
    async getKernel() {
      return null;
    },
    async emitLifecycleHint() {},
    onShutdown() {},
    async shutdown() {},
  };
}

function buildMemoryCommand(runtime: PluginRuntime, cfg: PluginConfig = {}): FakeCommand {
  let registered: RegisteredCli | null = null;
  const api = {
    config: selectedConfig,
    registerCli(builder: unknown, opts: RegisteredCli["opts"]) {
      registered = { builder: builder as RegisteredCli["builder"], opts };
    },
  };

  registerMemoryCli(api as never, runtime, cfg);

  assert.ok(registered);
  const cli = registered as RegisteredCli;
  const program = new FakeCommand("openclaw");
  cli.builder({ program });

  const memory = program.commands.find((command) => command.name() === "memory");
  assert.ok(memory);
  return memory;
}

test("CLI metadata registers the memory descriptor only when LibraVDB owns the memory slot", () => {
  const registered: RegisteredCli[] = [];
  const api = {
    config: selectedConfig,
    registerCli(builder: unknown, opts: RegisteredCli["opts"]) {
      registered.push({ builder: builder as RegisteredCli["builder"], opts });
    },
  };

  registerMemoryCliMetadata(api);

  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0]?.opts?.descriptors, [
    {
      name: "memory",
      description: "Manage LibraVDB memory",
      hasSubcommands: true,
    },
  ]);

  const skipped: RegisteredCli[] = [];
  registerMemoryCliMetadata({
    config: { plugins: { slots: { memory: "memory-core" } } },
    registerCli(builder: unknown, opts: RegisteredCli["opts"]) {
      skipped.push({ builder: builder as RegisteredCli["builder"], opts });
    },
  });
  assert.equal(skipped.length, 0);
});

test("full CLI registration exposes standard memory commands and LibraVDB operator commands", () => {
  let registered: RegisteredCli | null = null;
  const api = {
    config: selectedConfig,
    registerCli(builder: unknown, opts: RegisteredCli["opts"]) {
      registered = { builder: builder as RegisteredCli["builder"], opts };
    },
  };

  registerMemoryCli(api as never, createRuntime(), {});

  assert.ok(registered);
  const cli = registered as RegisteredCli;
  const program = new FakeCommand("openclaw");
  cli.builder({ program });

  const memory = program.commands.find((command) => command.name() === "memory");
  assert.ok(memory);
  assert.deepEqual(
    memory.commands.map((command) => command.name()),
    ["status", "index", "search", "flush", "export", "journal", "dream-promote"],
  );

  const status = memory.commands.find((command) => command.name() === "status");
  assert.ok(status);
  assert.ok(status.options.includes("--json"));
  assert.ok(status.options.includes("--agent <id>"));
  assert.ok(status.options.includes("--index"));
  assert.ok(status.options.includes("--force"));

  const search = memory.commands.find((command) => command.name() === "search");
  assert.ok(search);
  assert.ok(search.arguments.includes("[query]"));
  assert.ok(search.options.includes("--query <text>"));
  assert.ok(search.options.includes("--max-results <n>"));
  assert.ok(search.options.includes("--json"));

  const flush = memory.commands.find((command) => command.name() === "flush");
  assert.ok(flush);
  assert.ok(flush.options.includes("--user-id <userId>"));
  assert.ok(flush.options.includes("--session-key <sessionKey>"));
  assert.equal(flush.requiredOptions.includes("--user-id <userId>"), false);

  const dreamPromote = memory.commands.find((command) => command.name() === "dream-promote");
  assert.ok(dreamPromote);
  assert.ok(dreamPromote.requiredOptions.includes("--user-id <userId>"));
  assert.ok(dreamPromote.requiredOptions.includes("--dream-file <path>"));
});

test("flush command sends explicit user ids through the userId RPC field", async () => {
  const rpcCalls: Array<{ method: string; params: unknown }> = [];
  const memory = buildMemoryCommand({
    async getRpc() {
      return {
        async call(method: string, params: unknown) {
          rpcCalls.push({ method, params });
          return {};
        },
      } as never;
    },
    getKernel: async () => null,
    async emitLifecycleHint() {},
    onShutdown() {},
    async shutdown() {},
  });

  const flush = memory.commands.find((command) => command.name() === "flush");
  assert.ok(flush?.handler);

  const originalLog = console.log;
  console.log = (() => undefined) as typeof console.log;
  try {
    await flush.handler?.({ userId: "  alice  ", yes: true });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(rpcCalls, [
    {
      method: "flush_namespace",
      params: { userId: "alice" },
    },
  ]);
});

test("export command keeps user ids separate from derived namespaces", async () => {
  const rpcCalls: Array<{ method: string; params: unknown }> = [];
  const memory = buildMemoryCommand({
    async getRpc() {
      return {
        async call(method: string, params: unknown) {
          rpcCalls.push({ method, params });
          return { records: [] };
        },
      } as never;
    },
    getKernel: async () => null,
    async emitLifecycleHint() {},
    onShutdown() {},
    async shutdown() {},
  });

  const exportCmd = memory.commands.find((command) => command.name() === "export");
  assert.ok(exportCmd?.handler);

  await exportCmd.handler?.({ userId: "  alice  " });
  await exportCmd.handler?.({ sessionKey: "  session-1  " });

  assert.deepEqual(rpcCalls, [
    {
      method: "export_memory",
      params: { userId: "alice" },
    },
    {
      method: "export_memory",
      params: { namespace: "session-key:session-1" },
    },
  ]);
});

test("status command shuts the plugin runtime down after printing status", async () => {
  let registered: RegisteredCli | null = null;
  let shutdownCalls = 0;
  const api = {
    config: selectedConfig,
    registerCli(builder: unknown, opts: RegisteredCli["opts"]) {
      registered = { builder: builder as RegisteredCli["builder"], opts };
    },
  };

  registerMemoryCli(
    api as never,
    {
      async getRpc() {
        return {
          async call(method: string) {
            assert.equal(method, "status");
            return {
              ok: true,
              turnCount: 3,
              memoryCount: 3,
              lifecycleHintCount: 1,
              gatingThreshold: 0.35,
              abstractiveReady: true,
              embeddingProfile: "all-minilm-l6-v2",
              message: "ok",
            };
          },
        } as never;
      },
      async getKernel() {
        return null;
      },
      async emitLifecycleHint() {},
      onShutdown() {},
      async shutdown() {
        shutdownCalls += 1;
      },
    },
    {},
  );

  assert.ok(registered);
  const cli = registered as RegisteredCli;
  const program = new FakeCommand("openclaw");
  cli.builder({ program });

  const memory = program.commands.find((command) => command.name() === "memory");
  assert.ok(memory);
  const status = memory.commands.find((command) => command.name() === "status");
  assert.ok(status?.handler);

  const originalTable = console.table;
  console.table = (() => undefined) as typeof console.table;
  try {
    await status.handler?.({});
  } finally {
    console.table = originalTable;
  }

  assert.equal(shutdownCalls, 1);
});

test("status --index requires --force before rebuilding", async () => {
  let registered: RegisteredCli | null = null;
  let shutdownCalls = 0;
  let getRpcCalls = 0;
  const errors: string[] = [];
  const api = {
    config: selectedConfig,
    registerCli(builder: unknown, opts: RegisteredCli["opts"]) {
      registered = { builder: builder as RegisteredCli["builder"], opts };
    },
  };

  registerMemoryCli(
    api as never,
    {
      async getRpc() {
        getRpcCalls += 1;
        throw new Error("status --index without --force should not start RPC");
      },
      async getKernel() {
        return null;
      },
      async emitLifecycleHint() {},
      onShutdown() {},
      async shutdown() {
        shutdownCalls += 1;
      },
    },
    {},
    {
      error(message: string) {
        errors.push(message);
      },
    },
  );

  assert.ok(registered);
  const cli = registered as RegisteredCli;
  const program = new FakeCommand("openclaw");
  cli.builder({ program });

  const memory = program.commands.find((command) => command.name() === "memory");
  const status = memory?.commands.find((command) => command.name() === "status");
  assert.ok(status?.handler);

  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await status.handler?.({ index: true });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }

  assert.equal(getRpcCalls, 0);
  assert.equal(shutdownCalls, 1);
  assert.match(errors[0] ?? "", /--force/);
});

test("status --index --force rebuilds before printing status", async () => {
  let registered: RegisteredCli | null = null;
  let shutdownCalls = 0;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const api = {
    config: selectedConfig,
    registerCli(builder: unknown, opts: RegisteredCli["opts"]) {
      registered = { builder: builder as RegisteredCli["builder"], opts };
    },
  };

  registerMemoryCli(
    api as never,
    {
      async getRpc() {
        return {
          async call(method: string, params: Record<string, unknown>) {
            calls.push({ method, params });
            if (method === "rebuild_index") {
              return {
                collectionsProcessed: 1,
                recordsReindexed: 2,
                collectionsRecreated: 0,
                errors: [],
              };
            }
            if (method === "status") {
              return {
                ok: true,
                turnCount: 3,
                memoryCount: 3,
                lifecycleHintCount: 1,
                gatingThreshold: 0.35,
                abstractiveReady: true,
                embeddingProfile: "all-minilm-l6-v2",
                message: "ok",
              };
            }
            throw new Error(`unexpected rpc method: ${method}`);
          },
        } as never;
      },
      async getKernel() {
        return null;
      },
      async emitLifecycleHint() {},
      onShutdown() {},
      async shutdown() {
        shutdownCalls += 1;
      },
    },
    {},
  );

  assert.ok(registered);
  const cli = registered as RegisteredCli;
  const program = new FakeCommand("openclaw");
  cli.builder({ program });

  const memory = program.commands.find((command) => command.name() === "memory");
  const status = memory?.commands.find((command) => command.name() === "status");
  assert.ok(status?.handler);

  const originalTable = console.table;
  console.table = (() => undefined) as typeof console.table;
  try {
    await status.handler?.({ index: true, force: true });
  } finally {
    console.table = originalTable;
  }

  assert.deepEqual(calls.map((call) => call.method), ["rebuild_index", "status"]);
  assert.deepEqual(calls[0]?.params, { namespace: "" });
  assert.equal(shutdownCalls, 1);
});


test("search command applies the status gate threshold by default", async () => {
  let registered: RegisteredCli | null = null;
  const api = {
    config: selectedConfig,
    registerCli(builder: unknown, opts: RegisteredCli["opts"]) {
      registered = { builder: builder as RegisteredCli["builder"], opts };
    },
  };

  registerMemoryCli(
    api as never,
    {
      async getRpc() {
        return {
          async call(method: string) {
            if (method === "status") {
              return {
                ok: true,
                message: "ok",
                gatingThreshold: 0.5,
                embeddingProfile: "all-minilm-l6-v2",
              };
            }
            if (method === "search_text_collections") {
              return {
                results: [
                  {
                    id: "low",
                    score: 0.25,
                    text: "weak unrelated memory",
                    metadata: { collection: "user:test-user" },
                  },
                  {
                    id: "mid",
                    score: 0.4,
                    text: "mid-range memory gated by status threshold",
                    metadata: { collection: "user:test-user" },
                  },
                  {
                    id: "high",
                    score: 0.76,
                    text: "strong relevant memory",
                    metadata: { collection: "user:test-user" },
                  },
                ],
              };
            }
            throw new Error(`unexpected rpc method: ${method}`);
          },
        } as never;
      },
      getKernel: async () => null,
      async emitLifecycleHint() {},
      onShutdown: async () => {},
      async shutdown() {},
    },
    { userId: "test-user" },
  );

  assert.ok(registered);
  const cli = registered as RegisteredCli;
  const program = new FakeCommand("openclaw");
  cli.builder({ program });

  const memory = program.commands.find((command) => command.name() === "memory");
  const search = memory?.commands.find((command) => command.name() === "search");
  assert.ok(search?.handler);

  const originalLog = console.log;
  const logs: string[] = [];
  console.log = ((message?: unknown) => { logs.push(String(message)); }) as typeof console.log;
  try {
    await search.handler?.("query", {});
  } finally {
    console.log = originalLog;
  }

  assert.equal(logs.some((line) => line.includes("weak unrelated memory")), false);
  assert.equal(logs.some((line) => line.includes("mid-range memory gated by status threshold")), false);
  assert.equal(logs.some((line) => line.includes("strong relevant memory")), true);
});

test("search command honors an explicit min-score below the default threshold", async () => {
  let registered: RegisteredCli | null = null;
  const api = {
    config: selectedConfig,
    registerCli(builder: unknown, opts: RegisteredCli["opts"]) {
      registered = { builder: builder as RegisteredCli["builder"], opts };
    },
  };

  registerMemoryCli(
    api as never,
    {
      async getRpc() {
        return {
          async call(method: string) {
            if (method === "status") {
              return {
                ok: true,
                message: "ok",
                gatingThreshold: 0.35,
                embeddingProfile: "all-minilm-l6-v2",
              };
            }
            if (method === "search_text_collections") {
              return {
                results: [
                  {
                    id: "low",
                    score: 0.25,
                    text: "weak but explicitly requested memory",
                    metadata: { collection: "user:test-user" },
                  },
                ],
              };
            }
            throw new Error(`unexpected rpc method: ${method}`);
          },
        } as never;
      },
      getKernel: async () => null,
      async emitLifecycleHint() {},
      onShutdown: async () => {},
      async shutdown() {},
    },
    { userId: "test-user" },
  );

  assert.ok(registered);
  const cli = registered as RegisteredCli;
  const program = new FakeCommand("openclaw");
  cli.builder({ program });

  const memory = program.commands.find((command) => command.name() === "memory");
  const search = memory?.commands.find((command) => command.name() === "search");
  assert.ok(search?.handler);

  const originalLog = console.log;
  const logs: string[] = [];
  console.log = ((message?: unknown) => { logs.push(String(message)); }) as typeof console.log;
  try {
    await search.handler?.("query", { minScore: "0.2" });
  } finally {
    console.log = originalLog;
  }

  assert.equal(logs.some((line) => line.includes("weak but explicitly requested memory")), true);
});

test("status --deep probes authored collection search health", async () => {
  let registered: RegisteredCli | null = null;
  let shutdownCalls = 0;
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const api = {
    config: selectedConfig,
    registerCli(builder: unknown, opts: RegisteredCli["opts"]) {
      registered = { builder: builder as RegisteredCli["builder"], opts };
    },
  };

  registerMemoryCli(
    api as never,
    {
      async getRpc() {
        return {
          async call(method: string, params: Record<string, unknown>) {
            rpcCalls.push({ method, params });
            if (method === "status") {
              return { ok: true, message: "ok", embeddingProfile: "all-minilm-l6-v2" };
            }
            if (method === "search_text") {
              if (params.collection === "authored:soft") {
                throw new Error("query vector dimension 384 does not match collection dimension 1");
              }
              return { results: [] };
            }
            throw new Error(`unexpected rpc method: ${method}`);
          },
        } as never;
      },
      getKernel: async () => null,
      async emitLifecycleHint() {},
      onShutdown: async () => {},
      async shutdown() {
        shutdownCalls += 1;
      },
    },
    { userId: "default" },
  );

  assert.ok(registered);
  const cli = registered as RegisteredCli;
  const program = new FakeCommand("openclaw");
  cli.builder({ program });

  const memory = program.commands.find((command) => command.name() === "memory");
  const status = memory?.commands.find((command) => command.name() === "status");
  assert.ok(status?.handler);

  const originalLog = console.log;
  const previousExitCode = process.exitCode;
  const logs: string[] = [];
  let observedExitCode: string | number | undefined;
  console.log = ((message?: unknown) => { logs.push(String(message)); }) as typeof console.log;
  process.exitCode = undefined;
  try {
    await status.handler?.({ deep: true, json: true });
    observedExitCode = process.exitCode;
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
  }

  const payload = JSON.parse(logs[0] ?? "{}");
  assert.equal(payload.status.ok, true);
  assert.equal(payload.deep.ok, false);
  assert.deepEqual(
    rpcCalls.filter((call) => call.method === "search_text").map((call) => call.params.collection),
    ["authored:hard", "authored:soft", "authored:variant", "user:default", "global"],
  );
  assert.match(payload.deep.probes[1]?.error ?? "", /dimension 384/);
  assert.equal(observedExitCode, 1);
  assert.equal(shutdownCalls, 1);
});

test("status --deep reports invalid user collection without probing it", async () => {
  let registered: RegisteredCli | null = null;
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const api = {
    config: selectedConfig,
    registerCli(builder: unknown, opts: RegisteredCli["opts"]) {
      registered = { builder: builder as RegisteredCli["builder"], opts };
    },
  };

  registerMemoryCli(
    api as never,
    {
      async getRpc() {
        return {
          async call(method: string, params: Record<string, unknown>) {
            rpcCalls.push({ method, params });
            if (method === "status") {
              return { ok: true, message: "ok", embeddingProfile: "all-minilm-l6-v2" };
            }
            if (method === "search_text") {
              return { results: [] };
            }
            throw new Error(`unexpected rpc method: ${method}`);
          },
        } as never;
      },
      getKernel: async () => null,
      async emitLifecycleHint() {},
      onShutdown: async () => {},
      async shutdown() {},
    },
    { userId: "bad user" },
  );

  assert.ok(registered);
  const cli = registered as RegisteredCli;
  const program = new FakeCommand("openclaw");
  cli.builder({ program });

  const memory = program.commands.find((command) => command.name() === "memory");
  const status = memory?.commands.find((command) => command.name() === "status");
  assert.ok(status?.handler);

  const originalLog = console.log;
  const previousExitCode = process.exitCode;
  const logs: string[] = [];
  let observedExitCode: string | number | undefined;
  console.log = ((message?: unknown) => { logs.push(String(message)); }) as typeof console.log;
  process.exitCode = undefined;
  try {
    await status.handler?.({ deep: true, json: true });
    observedExitCode = process.exitCode;
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
  }

  const payload = JSON.parse(logs[0] ?? "{}");
  assert.equal(payload.deep.ok, false);
  assert.equal(payload.deep.probes[0]?.collection, "user:<invalid>");
  assert.match(payload.deep.probes[0]?.error ?? "", /Invalid collection namespace/);
  assert.deepEqual(
    rpcCalls.filter((call) => call.method === "search_text").map((call) => call.params.collection),
    ["authored:hard", "authored:soft", "authored:variant", "global"],
  );
  assert.equal(observedExitCode, 1);
});

test("status --deep includes authored probe rows in table output", async () => {
  let registered: RegisteredCli | null = null;
  const api = {
    config: selectedConfig,
    registerCli(builder: unknown, opts: RegisteredCli["opts"]) {
      registered = { builder: builder as RegisteredCli["builder"], opts };
    },
  };

  registerMemoryCli(
    api as never,
    {
      async getRpc() {
        return {
          async call(method: string, params: Record<string, unknown>) {
            if (method === "status") {
              return { ok: true, message: "ok", embeddingProfile: "all-minilm-l6-v2" };
            }
            if (method === "search_text") {
              if (params.collection === "authored:variant") {
                return { results: [{ id: "v1" }] };
              }
              if (params.collection === "global") {
                return { results: [{ id: "g1" }] };
              }
              return { results: [] };
            }
            throw new Error(`unexpected rpc method: ${method}`);
          },
        } as never;
      },
      getKernel: async () => null,
      async emitLifecycleHint() {},
      onShutdown: async () => {},
      async shutdown() {},
    },
    { userId: "default" },
  );

  assert.ok(registered);
  const cli = registered as RegisteredCli;
  const program = new FakeCommand("openclaw");
  cli.builder({ program });

  const memory = program.commands.find((command) => command.name() === "memory");
  const status = memory?.commands.find((command) => command.name() === "status");
  assert.ok(status?.handler);

  const originalTable = console.table;
  const previousExitCode = process.exitCode;
  const tables: Array<Record<string, unknown>> = [];
  console.table = ((value?: unknown) => {
    tables.push(value as Record<string, unknown>);
  }) as typeof console.table;
  process.exitCode = undefined;
  try {
    await status.handler?.({ deep: true });
  } finally {
    console.table = originalTable;
    process.exitCode = previousExitCode;
  }

  assert.equal(tables.length, 1);
  assert.equal(tables[0]?.["Deep probe"], "ok");
  assert.equal(tables[0]?.["Probe authored:hard"], "ok (0 hits)");
  assert.equal(tables[0]?.["Probe authored:soft"], "ok (0 hits)");
  assert.equal(tables[0]?.["Probe authored:variant"], "ok (1 hits)");
  assert.equal(tables[0]?.["Probe user:default"], "ok (0 hits)");
  assert.equal(tables[0]?.["Probe global"], "ok (1 hits)");
});

test("index command uses an extended timeout for rebuild_index", async () => {
  let registered: RegisteredCli | null = null;
  let shutdownCalls = 0;
  const rpcCalls: Array<{
    method: string;
    params: Record<string, unknown>;
    options?: { timeoutMs?: number };
  }> = [];
  const api = {
    config: selectedConfig,
    registerCli(builder: unknown, opts: RegisteredCli["opts"]) {
      registered = { builder: builder as RegisteredCli["builder"], opts };
    },
  };

  registerMemoryCli(
    api as never,
    {
      async getRpc() {
        return {
          async call(method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }) {
            rpcCalls.push({ method, params, options });
            if (method === "rebuild_index") {
              return {
                collectionsProcessed: 1,
                recordsReindexed: 2,
                collectionsRecreated: 0,
                errors: [],
              };
            }
            throw new Error(`unexpected rpc method: ${method}`);
          },
        } as never;
      },
      getKernel: async () => null,
      async emitLifecycleHint() {},
      onShutdown: async () => {},
      async shutdown() {
        shutdownCalls += 1;
      },
    },
    {},
  );

  assert.ok(registered);
  const cli = registered as RegisteredCli;
  const program = new FakeCommand("openclaw");
  cli.builder({ program });

  const memory = program.commands.find((command) => command.name() === "memory");
  const index = memory?.commands.find((command) => command.name() === "index");
  assert.ok(index?.handler);

  const originalLog = console.log;
  console.log = (() => {}) as typeof console.log;
  try {
    await index.handler?.({ force: true });
  } finally {
    console.log = originalLog;
  }

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0]?.method, "rebuild_index");
  assert.equal(rpcCalls[0]?.options?.timeoutMs, 300000);
  assert.equal(shutdownCalls, 1);
});

test("non-full CLI registration exposes command structure without action handlers", () => {
  let registered: RegisteredCli | null = null;
  const api = {
    config: selectedConfig,
    registerCli(builder: unknown, opts: RegisteredCli["opts"]) {
      registered = { builder: builder as RegisteredCli["builder"], opts };
    },
  };

  registerMemoryCli(api as never, null, {});

  assert.ok(registered);
  const cli = registered as RegisteredCli;
  const program = new FakeCommand("openclaw");
  cli.builder({ program });

  const memory = program.commands.find((command) => command.name() === "memory");
  assert.ok(memory);
  assert.deepEqual(
    memory.commands.map((command) => command.name()),
    ["status", "index", "search", "flush", "export", "journal", "dream-promote"],
  );
  assert.ok(memory.commands.every((command) => command.handler === null));
});

test("discovery registration exposes runtime-backed memory commands for lazy CLI loading", () => {
  let registered: RegisteredCli | null = null;
  let memoryCapabilityRegistrations = 0;
  let contextEngineRegistrations = 0;

  register({
    id: "libravdb-memory",
    name: "LibraVDB Memory",
    description: "Persistent vector memory with three-tier hybrid scoring",
    source: "test",
    registrationMode: "discovery",
    config: selectedConfig,
    pluginConfig: {},
    logger: {
      error(_msg: string) {},
      warn(_msg: string) {},
      info(_msg: string) {},
    },
    registerCli(builder: unknown, opts: RegisteredCli["opts"]) {
      registered = { builder: builder as RegisteredCli["builder"], opts };
    },
    registerMemoryCapability() {
      memoryCapabilityRegistrations += 1;
    },
    registerContextEngine() {
      contextEngineRegistrations += 1;
    },
    on() {
      assert.fail("discovery mode should not register full runtime hooks");
    },
  } as never);

  assert.ok(registered);
  assert.equal(memoryCapabilityRegistrations, 0);
  assert.equal(contextEngineRegistrations, 0);

  const cli = registered as RegisteredCli;
  const program = new FakeCommand("openclaw");
  cli.builder({ program });

  const memory = program.commands.find((command) => command.name() === "memory");
  assert.ok(memory);

  const status = memory.commands.find((command) => command.name() === "status");
  assert.ok(status?.handler);

  const journal = memory.commands.find((command) => command.name() === "journal");
  assert.ok(journal);
  assert.ok(journal.options.includes("--limit <limit>"));
});
