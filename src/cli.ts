import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { MEMORY_CLI_DESCRIPTOR, isMemorySlotSelected } from "./cli-descriptors.js";
import { resolveDurableNamespace } from "./memory-scopes.js";
import { promoteDreamDiaryFile } from "./dream-promotion.js";
import { buildMemoryRuntimeBridge } from "./memory-runtime.js";
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
  query?: string;
  userId?: string;
  agent?: string;
  sessionKey?: string;
  sessionId?: string;
  limit?: string | number;
  maxResults?: string | number;
  minScore?: string | number;
  yes?: boolean;
  json?: boolean;
  deep?: boolean;
  index?: boolean;
  fix?: boolean;
  force?: boolean;
  verbose?: boolean;
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
  argument?(name: string, description: string): CliCommand;
  option(flags: string, description: string): CliCommand;
  requiredOption?(flags: string, description: string): CliCommand;
  action(handler: (...args: unknown[]) => unknown): CliCommand;
  name?(): string;
};

type CliProgram = CliCommand;

export function registerMemoryCli(
  api: OpenClawPluginApi,
  runtime: PluginRuntime | null,
  cfg: PluginConfig,
  logger: LoggerLike = console,
): void {
  if (!api.registerCli) {
    return;
  }
  if (!isMemorySlotSelected(api)) {
    return;
  }

  const isFullMode = runtime !== null;

  api.registerCli(
    ({ program }) => {
      const root = ensureCommand(program, "memory")
        .description("Manage LibraVDB memory");

      if (!isFullMode) {
        // Non-full modes register structure only so `openclaw memory --help` works.
        // No runtime available — do not attach action handlers.
        ensureCommand(root, "status").description("Show sidecar health, record counts, and active thresholds");
        ensureCommand(root, "index").description("Refresh delegated LibraVDB memory index state");
        ensureCommand(root, "search").description("Search LibraVDB memory");
        ensureCommand(root, "flush").description("Wipe a durable memory namespace after confirmation");
        ensureCommand(root, "export").description("Stream stored memories as newline-delimited JSON");
        ensureCommand(root, "journal").description("Inspect internal lifecycle journal hints");
        ensureCommand(root, "dream-promote").description("Promote vetted dream diary entries into the dedicated dream collection");
        return;
      }

      ensureCommand(root, "status")
        .description("Show sidecar health, record counts, and active thresholds")
        .option("--agent <id>", "Agent id")
        .option("--json", "Print JSON")
        .option("--deep", "Probe daemon readiness")
        .option("--index", "Refresh delegated index state before printing status")
        .option("--fix", "Accepted for OpenClaw memory CLI compatibility")
        .option("--verbose", "Verbose logging")
        .action(async (opts) => {
          await runCliCommand(runtime, logger, async () => {
            await runStatus(runtime, cfg, logger, normalizeOptionBag(opts));
          });
        });

      ensureCommand(root, "index")
        .description("Refresh delegated LibraVDB memory index state")
        .option("--agent <id>", "Agent id")
        .option("--force", "Force refresh where supported")
        .option("--verbose", "Verbose logging")
        .action(async (opts) => {
          await runCliCommand(runtime, logger, async () => {
            await runIndex(runtime, cfg, normalizeOptionBag(opts), logger);
          });
        });

      const search = ensureCommand(root, "search")
        .description("Search LibraVDB memory")
        .option("--query <text>", "Search query (alternative to positional argument)")
        .option("--agent <id>", "Agent id")
        .option("--max-results <n>", "Max results")
        .option("--min-score <n>", "Minimum score")
        .option("--json", "Print JSON");
      search.argument?.("[query]", "Search query");
      search.action(async (queryOrOpts, maybeOpts) => {
        await runCliCommand(runtime, logger, async () => {
          await runSearch(
            runtime,
            cfg,
            normalizeQueryArg(queryOrOpts),
            normalizeActionOptions(queryOrOpts, maybeOpts),
            logger,
          );
        });
      });

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
        .action(async (opts) => {
          await runCliCommand(runtime, logger, async () => {
            await runFlush(runtime, normalizeOptionBag(opts), logger);
          });
        });

      const exportCmd = ensureCommand(root, "export")
        .description("Stream stored memories as newline-delimited JSON");
      exportCmd.option("--user-id <userId>", "Restrict export to a single user namespace");
      exportCmd.option("--session-key <sessionKey>", "Restrict export to a derived session-key namespace");
      exportCmd.action(async (opts) => {
        await runCliCommand(runtime, logger, async () => {
          await runExport(runtime, normalizeOptionBag(opts), logger);
        });
      });

      const journal = ensureCommand(root, "journal")
        .description("Inspect internal lifecycle journal hints");
      journal.option("--session-id <sessionId>", "Restrict journal entries to one session id");
      journal.option("--limit <limit>", "Maximum journal entries to show");
      journal.action(async (opts) => {
        await runCliCommand(runtime, logger, async () => {
          await runJournal(runtime, normalizeOptionBag(opts), logger);
        });
      });

      const dreamPromote = ensureCommand(root, "dream-promote")
        .description("Promote vetted dream diary entries into the dedicated dream collection");
      if (dreamPromote.requiredOption) {
        dreamPromote.requiredOption("--user-id <userId>", "User id whose dream collection should receive the promotion");
        dreamPromote.requiredOption("--dream-file <path>", "Dream diary markdown file to promote from");
      } else {
        dreamPromote.option("--user-id <userId>", "User id whose dream collection should receive the promotion");
        dreamPromote.option("--dream-file <path>", "Dream diary markdown file to promote from");
      }
      dreamPromote.action(async (opts) => {
        await runCliCommand(runtime, logger, async () => {
          await runDreamPromote(runtime, normalizeOptionBag(opts), logger);
        });
      });
    },
    {
      descriptors: [MEMORY_CLI_DESCRIPTOR],
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

async function runCliCommand(
  runtime: PluginRuntime,
  logger: LoggerLike,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } finally {
    try {
      await runtime.shutdown();
    } catch (error) {
      logger.warn?.(`LibraVDB CLI shutdown failed: ${formatError(error)}`);
    }
  }
}

async function runStatus(
  runtime: PluginRuntime,
  cfg: PluginConfig,
  logger: LoggerLike,
  opts: CliOptionBag = {},
): Promise<void> {
  if (opts.index) {
    await runIndex(runtime, cfg, { ...opts, verbose: false }, logger, { quiet: true });
  }
  try {
    const rpc = await runtime.getRpc();
    const status = await rpc.call<StatusResult>("status", {});
    if (opts.json) {
      console.log(JSON.stringify({ status }, null, 2));
      return;
    }
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
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            status: {
              ok: false,
              message: formatError(error),
              gatingThreshold: cfg.ingestionGateThreshold ?? 0.35,
            },
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
      return;
    }
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

async function runIndex(
  runtime: PluginRuntime,
  cfg: PluginConfig,
  opts: CliOptionBag | undefined,
  logger: LoggerLike,
  params: { quiet?: boolean } = {},
): Promise<void> {
  try {
    const bridge = buildMemoryRuntimeBridge(runtime.getRpc, cfg);
    const { manager } = await bridge.getMemorySearchManager({
      agentId: opts?.agent,
      purpose: "status",
    });
    await manager.sync?.({
      reason: "cli",
      force: Boolean(opts?.force),
    });
    const status = manager.status();
    if (status.ok === false) {
      logger.error(`LibraVDB index refresh unavailable: ${status.message ?? "sidecar unavailable"}`);
      process.exitCode = 1;
      return;
    }
    if (opts?.verbose && !params.quiet) {
      console.table({
        Provider: status.provider ?? "libravdb",
        Model: status.model ?? status.embeddingProfile ?? "unknown",
        "Turns stored": status.turnCount ?? 0,
        "Memories stored": status.memoryCount ?? 0,
        Message: status.message ?? "ok",
      });
    }
    if (!params.quiet) {
      console.log("LibraVDB memory index refresh delegated to the sidecar.");
    }
  } catch (error) {
    logger.error(`LibraVDB index refresh failed: ${formatError(error)}`);
    process.exitCode = 1;
  }
}

async function runSearch(
  runtime: PluginRuntime,
  cfg: PluginConfig,
  queryArg: string | undefined,
  opts: CliOptionBag | undefined,
  logger: LoggerLike,
): Promise<void> {
  const query = opts?.query?.trim() || queryArg?.trim();
  if (!query) {
    logger.error("LibraVDB search requires a query. Provide a positional query or --query <text>.");
    process.exitCode = 1;
    return;
  }

  try {
    const bridge = buildMemoryRuntimeBridge(runtime.getRpc, cfg);
    const { manager } = await bridge.getMemorySearchManager({
      agentId: opts?.agent,
    });
    const maxResults = normalizeLimit(opts?.maxResults ?? opts?.limit);
    const minScore = normalizeNumber(opts?.minScore);
    const results = (await manager.search(
      {
        query,
        ...(maxResults ? { maxResults } : {}),
        ...(minScore !== undefined ? { minScore } : {}),
      },
    )) as Array<{
      path: string;
      startLine: number;
      endLine: number;
      score: number;
      snippet: string;
    }>;
    if (opts?.json) {
      console.log(JSON.stringify({ results }, null, 2));
      return;
    }
    if (results.length === 0) {
      console.log("No matches.");
      return;
    }
    for (const result of results) {
      console.log(`${result.score.toFixed(3)} ${result.path}:${result.startLine}-${result.endLine}`);
      console.log(result.snippet);
      console.log("");
    }
  } catch (error) {
    logger.error(`LibraVDB search failed: ${formatError(error)}`);
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

function normalizeNumber(value: string | number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeOptionBag(value: unknown): CliOptionBag {
  return value && typeof value === "object" ? (value as CliOptionBag) : {};
}

function normalizeActionOptions(queryOrOpts: unknown, maybeOpts: unknown): CliOptionBag {
  if (maybeOpts && typeof maybeOpts === "object") {
    return maybeOpts as CliOptionBag;
  }
  return normalizeOptionBag(queryOrOpts);
}

function normalizeQueryArg(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
