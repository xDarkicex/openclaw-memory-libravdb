import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { MEMORY_CLI_DESCRIPTOR, isMemorySlotSelected } from "./cli-descriptors.js";
import { resolveDurableNamespace, resolveUserCollection } from "./memory-scopes.js";
import { resolveIdentity } from "./identity.js";
import { formatError } from "./format-error.js";
import { promoteDreamDiaryFile } from "./dream-promotion.js";
import { buildMemoryRuntimeBridge } from "./memory-runtime.js";
import type { PluginRuntime } from "./plugin-runtime.js";
import type { LibravDBClient } from "./libravdb-client.js";
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

type DeepStatusProbe = {
  ok: boolean;
  collection: string;
  resultCount?: number;
  error?: string;
};

type DeepStatusResult = {
  ok: boolean;
  probes: DeepStatusProbe[];
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
  collections?: string;
};

type JournalResult = {
  results?: Array<{
    id: string;
    metadata: Record<string, unknown>;
  }>;
};

const INDEX_REBUILD_TIMEOUT_MS = 5 * 60 * 1000;

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
type CliMemoryOperationScope = {
  displayName: string;
  params: {
    userId?: string;
    namespace?: string;
  };
};

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
        ensureCommand(root, "index").description("Rebuild LibraVDB memory vector index (requires --force)");
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
        .option("--deep", "Probe authored collection search health")
        .option("--index", "Rebuild the index before printing status")
        .option("--force", "Required with --index: confirm index rebuild")
        .option("--fix", "Accepted for OpenClaw memory CLI compatibility")
        .option("--verbose", "Verbose logging")
        .action(async (opts) => {
          await runCliCommand(runtime, logger, async () => {
            await runStatus(runtime, cfg, logger, normalizeOptionBag(opts));
          });
        });

      ensureCommand(root, "index")
        .description("Rebuild LibraVDB memory vector index (requires --force)")
        .option("--agent <id>", "Agent id")
        .option("--user-id <userId>", "User id")
        .option("--session-key <sessionKey>", "Session key")
        .option("--collections <list>", "Comma-separated collection names to reindex")
        .option("--force", "Required: confirm index rebuild")
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
      flush.option("--user-id <userId>", "User id whose durable memory should be deleted");
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
    if (!opts.force) {
      logger.error("LibraVDB status --index performs an index rebuild. Re-run with --force to continue.");
      process.exitCode = 1;
      return;
    }
    const ok = await runIndex(runtime, cfg, { ...opts, verbose: false }, logger, { quiet: true });
    if (!ok) {
      return;
    }
  }

  try {
    const client = await runtime.getClient();
    const status = await client.status({});
    const deep = opts.deep ? await runDeepStatusProbe(client, cfg) : undefined;
    if (opts.json) {
      console.log(JSON.stringify({ status, ...(deep ? { deep } : {}) }, null, 2));
      if (deep && !deep.ok) {
        process.exitCode = 1;
      }
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
      ...(deep ? formatDeepStatusTableRows(deep) : {}),
      Message: status.message ?? (status.ok ? "ok" : "unavailable"),
    });
    if (deep && !deep.ok) {
      process.exitCode = 1;
    }
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

const AUTHORED_STATUS_COLLECTIONS = ["authored:hard", "authored:soft", "authored:variant"] as const;

async function runDeepStatusProbe(
  client: { searchText(params: { collection: string; text: string; k: number }): Promise<{ results?: unknown[] }> },
  cfg: PluginConfig,
): Promise<DeepStatusResult> {
  // Resolve userId without triggering auto-derive file writes.
  // status --deep should be read-only; if no userId is configured and no
  // identity file exists, fall back to "default" rather than creating one.
  const { userId } = resolveIdentity({
    configUserId: cfg.userId,
    identityPath: cfg.identityPath,
    noAutoPersist: true,
  });
  const probes: DeepStatusProbe[] = [];
  let userCollection: string | null = null;
  try {
    userCollection = resolveUserCollection(userId);
  } catch (error) {
    probes.push({
      ok: false,
      collection: "user:<invalid>",
      error: formatError(error),
    });
  }

  const durableCollections = userCollection ? [userCollection, "global"] : ["global"];
  const allCollections = [...AUTHORED_STATUS_COLLECTIONS, ...durableCollections];

  for (const collection of allCollections) {
    try {
      const result = await client.searchText({
        collection,
        text: "memory",
        k: 1,
      });
      probes.push({
        ok: true,
        collection,
        resultCount: Array.isArray(result.results) ? result.results.length : 0,
      });
    } catch (error) {
      probes.push({
        ok: false,
        collection,
        error: formatError(error),
      });
    }
  }
  return {
    ok: probes.every((probe) => probe.ok),
    probes,
  };
}

function formatDeepStatusTableRows(deep: DeepStatusResult): Record<string, string> {
  const rows: Record<string, string> = {
    "Deep probe": deep.ok ? "ok" : "failed",
  };
  for (const probe of deep.probes) {
    rows[`Probe ${probe.collection}`] = probe.ok
      ? `ok (${probe.resultCount ?? 0} hits)`
      : `failed: ${probe.error ?? "unknown error"}`;
  }
  return rows;
}

async function runIndex(
  runtime: PluginRuntime,
  cfg: PluginConfig,
  opts: CliOptionBag | undefined,
  logger: LoggerLike,
  params: { quiet?: boolean } = {},
): Promise<boolean> {
  if (!opts?.force) {
    logger.error("LibraVDB index rebuild requires --force. This re-embeds all stored documents with the current model and may be slow.");
    process.exitCode = 1;
    return false;
  }

  const namespace = resolveCliNamespace(opts);
  const collections = opts?.collections
    ?.split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  try {
    const client = await runtime.getClient();
    const result = await client.rebuildIndex({
      namespace: namespace ?? "",
      ...(collections?.length ? { collections } : {}),
    }, { timeoutMs: resolveIndexRebuildTimeoutMs(cfg) });

    if (!params.quiet) {
      console.log(`Collections processed: ${result.collectionsProcessed ?? 0}`);
      console.log(`Records reindexed:     ${result.recordsReindexed ?? 0}`);
      if ((result.collectionsRecreated ?? 0) > 0) {
        console.log(`Collections recreated: ${result.collectionsRecreated} (embedding dimensions changed)`);
      }
    }

    for (const err of result.errors ?? []) {
      logger.warn?.(`LibraVDB index rebuild: ${err}`);
    }

    if ((result.errors?.length ?? 0) > 0 && (result.recordsReindexed ?? 0) === 0) {
      logger.error("LibraVDB index rebuild completed with errors and no records reindexed.");
      process.exitCode = 1;
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`LibraVDB index rebuild failed: ${formatError(error)}`);
    process.exitCode = 1;
    return false;
  }
}

function resolveIndexRebuildTimeoutMs(cfg: PluginConfig): number {
  return Math.max(INDEX_REBUILD_TIMEOUT_MS, cfg.rpcTimeoutMs ?? 0);
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

  let maxResults: number | undefined;
  let explicitMinScore: number | undefined;
  try {
    maxResults = normalizeCliLimit(opts?.maxResults ?? opts?.limit, "--max-results");
    explicitMinScore = normalizeCliScore(opts?.minScore, "--min-score");
  } catch (validationError) {
    logger.error(formatError(validationError));
    process.exitCode = 1;
    return;
  }

  try {
    const bridge = buildMemoryRuntimeBridge(runtime.getClient, cfg);
    const { manager } = await bridge.getMemorySearchManager({
      agentId: opts?.agent,
    });
    const minScore = explicitMinScore ?? resolveDefaultSearchMinScore(manager.status(), cfg);
    const results = (await manager.search(
      {
        query,
        ...(maxResults ? { maxResults } : {}),
        minScore,
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

function resolveDefaultSearchMinScore(status: { gatingThreshold?: number } | undefined, cfg: PluginConfig): number {
  return normalizeNumber(status?.gatingThreshold) ?? normalizeNumber(cfg.ingestionGateThreshold) ?? 0.35;
}

async function runFlush(runtime: PluginRuntime, opts: CliOptionBag | undefined, logger: LoggerLike): Promise<void> {
  const scope = resolveCliMemoryOperationScope(opts);
  if (!scope) {
    logger.error("LibraVDB flush requires --user-id <userId> or --session-key <sessionKey>.");
    process.exitCode = 1;
    return;
  }

  if (!opts?.yes) {
    const confirmed = await confirm(`Delete durable memory namespace ${scope.displayName}? [y/N] `);
    if (!confirmed) {
      console.log("Aborted.");
      return;
    }
  }

  try {
    const client = await runtime.getClient();
    await client.flushNamespace(scope.params);
    console.log(`Deleted durable memory namespace ${scope.displayName}.`);
  } catch (error) {
    logger.error(`LibraVDB flush failed: ${formatError(error)}`);
    process.exitCode = 1;
  }
}

async function runExport(runtime: PluginRuntime, opts: CliOptionBag | undefined, logger: LoggerLike): Promise<void> {
  const scope = resolveCliMemoryOperationScope(opts);
  if (!scope) {
    logger.error("LibraVDB export requires a namespace. Provide --user-id or --session-key.");
    process.exitCode = 1;
    return;
  }

  try {
    const client = await runtime.getClient();
    const result = await client.exportMemory(scope.params);
    for (const record of result.records ?? []) {
      stdout.write(`${JSON.stringify(record)}\n`);
    }
  } catch (error) {
    logger.error(`LibraVDB export failed: ${formatError(error)}`);
    process.exitCode = 1;
  }
}

async function runJournal(runtime: PluginRuntime, opts: CliOptionBag | undefined, logger: LoggerLike): Promise<void> {
  let limit: number | undefined;
  try {
    limit = normalizeCliLimit(opts?.limit, "--limit");
  } catch (validationError) {
    logger.error(formatError(validationError));
    process.exitCode = 1;
    return;
  }

  try {
    const client = await runtime.getClient();
    const result = await client.listLifecycleJournal({
      sessionId: opts?.sessionId?.trim() || undefined,
      limit,
    });
    for (const entry of result.entries) {
      stdout.write(`${entry}\n`);
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
    const client = await runtime.getClient();
    const result = await promoteDreamDiaryFile(client, { userId, diaryPath: dreamFile });
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


function normalizeCliLimit(limit: string | number | undefined, optionName: string): number | undefined {
  if (limit === undefined) return undefined;
  const parsed = parseStrictNumber(limit);
  if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  throw new Error(`Invalid value for ${optionName}: must be a positive integer`);
}

function normalizeCliScore(value: string | number | undefined, optionName: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseStrictNumber(value);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
    return parsed;
  }
  throw new Error(`Invalid value for ${optionName}: must be a number between 0 and 1`);
}

function parseStrictNumber(value: string | number): number {
  if (typeof value === "number") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === "" ? NaN : Number(trimmed);
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
  const agentId = opts?.agent?.trim();
  if (!userId && !sessionKey && !agentId) {
    return undefined;
  }
  return resolveDurableNamespace({ userId, sessionKey, agentId });
}

function resolveCliMemoryOperationScope(opts: CliOptionBag | undefined): CliMemoryOperationScope | undefined {
  const userId = opts?.userId?.trim();
  if (userId) {
    return {
      displayName: `user:${userId}`,
      params: { userId },
    };
  }

  const sessionKey = opts?.sessionKey?.trim();
  const agentId = opts?.agent?.trim();
  if (!sessionKey && !agentId) {
    return undefined;
  }
  const namespace = resolveDurableNamespace({ sessionKey, agentId });
  return {
    displayName: namespace,
    params: { namespace },
  };
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
