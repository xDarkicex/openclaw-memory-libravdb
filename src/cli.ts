import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveDurableNamespace } from "./durable-namespace.js";
import { promoteDreamDiaryFile } from "./dream-promotion.js";
import type { PluginRuntime } from "./plugin-runtime.js";
import type { LoggerLike, PluginConfig } from "./types.js";

type StatusResult = {
  ok?: boolean;
  message?: string;
  turnCount?: number;
  memoryCount?: number;
  lifecycleHintCount?: number;
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
  dreamFile?: string;
  userId?: string;
  sessionKey?: string;
  sessionId?: string;
  limit?: string | number;
  yes?: boolean;
};

type JournalResult = {
  results?: Array<{
    id: string;
    metadata: Record<string, unknown>;
  }>;
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
        .description("Wipe a durable memory namespace after confirmation");
      if (flush.requiredOption) {
        flush.requiredOption("--user-id <userId>", "User id whose durable memory should be deleted");
      } else {
        flush.option("--user-id <userId>", "User id whose durable memory should be deleted");
      }
      flush.option("--session-key <sessionKey>", "Session key whose derived durable namespace should be deleted");
      flush
        .option("--yes", "Skip the confirmation prompt")
        .action((opts) => void runFlush(runtime, opts, logger));

      const exportCmd = ensureCommand(root, "export")
        .description("Stream stored memories as newline-delimited JSON");
      exportCmd.option("--user-id <userId>", "Restrict export to a single user namespace");
      exportCmd.option("--session-key <sessionKey>", "Restrict export to a derived session-key namespace");
      exportCmd.action((opts) => void runExport(runtime, opts, logger));

      const journal = ensureCommand(root, "journal")
        .description("Inspect internal lifecycle journal hints");
      journal.option("--session-id <sessionId>", "Restrict journal entries to one session id");
      journal.option("--limit <limit>", "Maximum journal entries to show");
      journal.action((opts) => void runJournal(runtime, opts, logger));

      const dreamPromote = ensureCommand(root, "dream-promote")
        .description("Promote vetted dream diary entries into the dedicated dream collection");
      if (dreamPromote.requiredOption) {
        dreamPromote.requiredOption("--user-id <userId>", "User id whose dream collection should receive the promotion");
        dreamPromote.requiredOption("--dream-file <path>", "Dream diary markdown file to promote from");
      } else {
        dreamPromote.option("--user-id <userId>", "User id whose dream collection should receive the promotion");
        dreamPromote.option("--dream-file <path>", "Dream diary markdown file to promote from");
      }
      dreamPromote.action((opts) => void runDreamPromote(runtime, opts, logger));
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
      "Lifecycle hints": status.lifecycleHintCount ?? 0,
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
      "Lifecycle hints": "n/a",
      "Gate threshold": cfg.ingestionGateThreshold ?? 0.35,
      "Abstractive model": "unknown",
      "Embedding profile": "unknown",
      Message: formatError(error),
    });
    process.exitCode = 1;
  }
}

async function runFlush(runtime: PluginRuntime, opts: CliOptionBag | undefined, logger: LoggerLike): Promise<void> {
  const namespace = resolveCliNamespace(opts);
  if (!namespace) {
    logger.error("LibraVDB flush requires --user-id <userId> or --session-key <sessionKey>.");
    process.exitCode = 1;
    return;
  }

  if (!opts?.yes) {
    const confirmed = await confirm(`Delete durable memory namespace ${namespace}? [y/N] `);
    if (!confirmed) {
      console.log("Aborted.");
      return;
    }
  }

  try {
    const rpc = await runtime.getRpc();
    await rpc.call("flush_namespace", { namespace });
    console.log(`Deleted durable memory namespace ${namespace}.`);
  } catch (error) {
    logger.error(`LibraVDB flush failed: ${formatError(error)}`);
    process.exitCode = 1;
  }
}

async function runExport(runtime: PluginRuntime, opts: CliOptionBag | undefined, logger: LoggerLike): Promise<void> {
  try {
    const rpc = await runtime.getRpc();
    const result = await rpc.call<ExportResult>("export_memory", {
      namespace: resolveCliNamespace(opts),
    });
    for (const record of result.records ?? []) {
      stdout.write(`${JSON.stringify(record)}\n`);
    }
  } catch (error) {
    logger.error(`LibraVDB export failed: ${formatError(error)}`);
    process.exitCode = 1;
  }
}

async function runJournal(runtime: PluginRuntime, opts: CliOptionBag | undefined, logger: LoggerLike): Promise<void> {
  try {
    const rpc = await runtime.getRpc();
    const result = await rpc.call<JournalResult>("list_lifecycle_journal", {
      sessionId: opts?.sessionId?.trim() || undefined,
      limit: normalizeLimit(opts?.limit),
    });
    for (const record of result.results ?? []) {
      stdout.write(`${JSON.stringify(record)}\n`);
    }
  } catch (error) {
    logger.error(`LibraVDB journal lookup failed: ${formatError(error)}`);
    process.exitCode = 1;
  }
}

async function runDreamPromote(runtime: PluginRuntime, opts: CliOptionBag | undefined, logger: LoggerLike): Promise<void> {
  const userId = opts?.userId?.trim();
  const dreamFile = opts?.dreamFile?.trim();
  if (!userId || !dreamFile) {
    logger.error("LibraVDB dream-promote requires --user-id <userId> and --dream-file <path>.");
    process.exitCode = 1;
    return;
  }

  try {
    const rpc = await runtime.getRpc();
    const result = await promoteDreamDiaryFile(rpc, { userId, diaryPath: dreamFile });
    console.log(
      `Promoted ${result.promoted ?? 0} dream entr${(result.promoted ?? 0) === 1 ? "y" : "ies"}; rejected ${result.rejected ?? 0}.`,
    );
  } catch (error) {
    logger.error(`LibraVDB dream promotion failed: ${formatError(error)}`);
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

function normalizeLimit(limit: string | number | undefined): number | undefined {
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    return Math.floor(limit);
  }
  if (typeof limit === "string") {
    const parsed = Number.parseInt(limit, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function resolveCliNamespace(opts: CliOptionBag | undefined): string | undefined {
  const userId = opts?.userId?.trim();
  const sessionKey = opts?.sessionKey?.trim();
  if (!userId && !sessionKey) {
    return undefined;
  }
  return resolveDurableNamespace({ userId, sessionKey });
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
