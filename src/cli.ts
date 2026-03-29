import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "./plugin-runtime.js";
import type { LoggerLike, PluginConfig } from "./types.js";

type StatusResult = {
  ok?: boolean;
  message?: string;
  turnCount?: number;
  memoryCount?: number;
  gatingThreshold?: number;
  abstractiveReady?: boolean;
  embeddingProfile?: string;
};

type ExportResult = {
  records?: Array<{
    collection: string;
    id: string;
    text: string;
    metadata: Record<string, unknown>;
  }>;
};

type CliOptionBag = {
  userId?: string;
  yes?: boolean;
};

type CliCommand = {
  commands?: CliCommand[];
  command(name: string): CliCommand;
  description(text: string): CliCommand;
  option(flags: string, description: string): CliCommand;
  requiredOption?(flags: string, description: string): CliCommand;
  action(handler: (opts?: CliOptionBag) => unknown): CliCommand;
  name?(): string;
};

type CliProgram = CliCommand;

export function registerMemoryCli(
  api: OpenClawPluginApi,
  runtime: PluginRuntime,
  cfg: PluginConfig,
  logger: LoggerLike = console,
): void {
  if (!api.registerCli) {
    return;
  }

  api.registerCli(
    ({ program }) => {
      const root = ensureCommand(program, "memory")
        .description("Manage LibraVDB memory");

      ensureCommand(root, "status")
        .description("Show sidecar health, record counts, and active thresholds")
        .action(() => void runStatus(runtime, cfg, logger));

      const flush = ensureCommand(root, "flush")
        .description("Wipe a user memory namespace after confirmation");
      if (flush.requiredOption) {
        flush.requiredOption("--user-id <userId>", "User id whose durable memory should be deleted");
      } else {
        flush.option("--user-id <userId>", "User id whose durable memory should be deleted");
      }
      flush
        .option("--yes", "Skip the confirmation prompt")
        .action((opts) => void runFlush(runtime, opts, logger));

      const exportCmd = ensureCommand(root, "export")
        .description("Stream stored memories as newline-delimited JSON");
      exportCmd.option("--user-id <userId>", "Restrict export to a single user namespace");
      exportCmd.action((opts) => void runExport(runtime, opts, logger));
    },
    {
      descriptors: [
        {
          name: "memory",
          description: "Manage LibraVDB memory",
          hasSubcommands: true,
        },
      ],
    },
  );
}

function ensureCommand(parent: CliCommand, name: string): CliCommand {
  const existing = parent.commands?.find((command) => {
    if (typeof command.name === "function") {
      return command.name() === name;
    }
    return false;
  });
  if (existing) {
    return existing;
  }
  return parent.command(name);
}

async function runStatus(runtime: PluginRuntime, cfg: PluginConfig, logger: LoggerLike): Promise<void> {
  try {
    const rpc = await runtime.getRpc();
    const status = await rpc.call<StatusResult>("status", {});
    console.table({
      Sidecar: status.ok ? "running" : "down",
      "Turns stored": status.turnCount ?? 0,
      "Memories stored": status.memoryCount ?? 0,
      "Gate threshold": status.gatingThreshold ?? cfg.ingestionGateThreshold ?? 0.35,
      "Abstractive model": status.abstractiveReady ? "ready" : "not provisioned",
      "Embedding profile": status.embeddingProfile ?? "unknown",
      Message: status.message ?? (status.ok ? "ok" : "unavailable"),
    });
  } catch (error) {
    logger.error(`LibraVDB status unavailable: ${formatError(error)}`);
    console.table({
      Sidecar: "down",
      "Turns stored": "n/a",
      "Memories stored": "n/a",
      "Gate threshold": cfg.ingestionGateThreshold ?? 0.35,
      "Abstractive model": "unknown",
      "Embedding profile": "unknown",
      Message: formatError(error),
    });
    process.exitCode = 1;
  }
}

async function runFlush(runtime: PluginRuntime, opts: CliOptionBag | undefined, logger: LoggerLike): Promise<void> {
  const userId = opts?.userId?.trim();
  if (!userId) {
    logger.error("LibraVDB flush requires --user-id <userId>.");
    process.exitCode = 1;
    return;
  }

  if (!opts?.yes) {
    const confirmed = await confirm(`Delete durable memory collection user:${userId}? [y/N] `);
    if (!confirmed) {
      console.log("Aborted.");
      return;
    }
  }

  try {
    const rpc = await runtime.getRpc();
    await rpc.call("flush_namespace", { userId });
    console.log(`Deleted durable memory namespace user:${userId}.`);
  } catch (error) {
    logger.error(`LibraVDB flush failed: ${formatError(error)}`);
    process.exitCode = 1;
  }
}

async function runExport(runtime: PluginRuntime, opts: CliOptionBag | undefined, logger: LoggerLike): Promise<void> {
  try {
    const rpc = await runtime.getRpc();
    const result = await rpc.call<ExportResult>("export_memory", {
      userId: opts?.userId?.trim() || undefined,
    });
    for (const record of result.records ?? []) {
      stdout.write(`${JSON.stringify(record)}\n`);
    }
  } catch (error) {
    logger.error(`LibraVDB export failed: ${formatError(error)}`);
    process.exitCode = 1;
  }
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(prompt);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

type CliRegistrar = {
  registerCli?(
    builder: (ctx: { program: CliProgram }) => void,
    opts?: {
      commands?: string[];
      descriptors?: Array<{
        name: string;
        description: string;
        hasSubcommands: boolean;
      }>;
    },
  ): void;
};

declare module "openclaw/plugin-sdk/plugin-entry" {
  interface OpenClawPluginApi extends CliRegistrar {}
}
