import test from "node:test";
import assert from "node:assert/strict";

import { registerMemoryCli } from "../../src/cli.js";
import { registerMemoryCliMetadata } from "../../src/cli-descriptors.js";
import { register } from "../../src/index.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";

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
    getKernel() {
      return null;
    },
    async emitLifecycleHint() {},
    async shutdown() {},
  };
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

  const search = memory.commands.find((command) => command.name() === "search");
  assert.ok(search);
  assert.ok(search.arguments.includes("[query]"));
  assert.ok(search.options.includes("--query <text>"));
  assert.ok(search.options.includes("--max-results <n>"));
  assert.ok(search.options.includes("--json"));
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
      getKernel() {
        return null;
      },
      async emitLifecycleHint() {},
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
