import { resolveIdentity } from "./identity.js";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerMemoryCli } from "./cli.js";
import { registerMemoryCliMetadata } from "./cli-descriptors.js";
import { buildContextEngineFactory, clearSessionTrigger, extractSpeakers, normalizeKernelMessage, setSessionTrigger } from "./context-engine.js";
import { createBeforeResetHook, createSessionEndHook } from "./lifecycle-hooks.js";
import { createDreamPromotionHandle } from "./dream-promotion.js";
import { createMarkdownIngestionHandle } from "./markdown-ingest.js";
import { buildMemoryPromptSection } from "./memory-provider.js";
import { createMemoryDescribeTool, createMemoryExpandTool, createMemoryGrepTool, createUpdateUserCardTool, createGetUserCardTool, createListUserCardsTool } from "./tools/memory-recall.js";
import { createSetRuleTool, createGetRuleTool, createListRulesTool, createDeleteRuleTool, initRuleStore, buildRulesContext, scanReply } from "./rules.js";
import type { ClientGetter } from "./plugin-runtime.js";
import { buildMemoryRuntimeBridge } from "./memory-runtime.js";
import { createLibraVdbMemoryTools } from "./memory-tools.js";
import { createPluginRuntime } from "./plugin-runtime.js";
import type { PluginConfig } from "./types.js";
import { levelFilteredLogger } from "./types.js";

export const MEMORY_ID = "libravdb-memory";

const LIGHTWEIGHT_MODES = new Set(["cli-metadata", "setup-only"]);
const RUNTIME_CLEANUP_SHUTDOWN_REASONS = new Set(["delete"]);

export function shouldShutdownRuntimeForLifecycleCleanup(
  reason: string,
  sessionKey?: string,
): boolean {
  // `reason: "delete"` fires for per-session deletes (sessionKey set) as well as
  // plugin-scoped teardown (no sessionKey). The vector-service runtime is a
  // process-wide singleton shared by every session's context engine, memory tools,
  // and compaction provider, so it must only be torn down on a plugin-scoped cleanup.
  // Shutting it down on a single session delete leaves it permanently "shut down"
  // and breaks memory ingestion for every other live session until a gateway restart.
  return RUNTIME_CLEANUP_SHUTDOWN_REASONS.has(reason) && sessionKey === undefined;
}

export function register(api: OpenClawPluginApi) {
  const registrationMode = api.registrationMode;
  const baseLogger = api.logger ?? console;
  const logger = levelFilteredLogger(baseLogger, (api.pluginConfig as PluginConfig)?.logLevel);

  if (registrationMode === "cli-metadata") {
    registerMemoryCliMetadata(api);
    return;
  }

  const cfg = api.pluginConfig as PluginConfig;
  const isLightweight = LIGHTWEIGHT_MODES.has(registrationMode);
  const isDiscovery = registrationMode === "discovery";

  logger.info?.(
    `LibraVDB registering mode=${registrationMode} lightweight=${isLightweight} ` +
    `discovery=${isDiscovery} userId=${cfg.userId ?? "(auto)"} ` +
    `crossSessionRecall=${cfg.crossSessionRecall !== false}`,
  );

  // Slot gating: reject conflicts and skip explicit opt-out BEFORE runtime
  // creation, so no work is wasted when memory is disabled or misconfigured.
  const memSlot = api.config?.plugins?.slots?.memory;
  const ctxSlot = api.config?.plugins?.slots?.contextEngine;
  if (!isLightweight && !isDiscovery) {
    if (memSlot && memSlot !== MEMORY_ID && memSlot !== "none") {
      throw new Error(
        `[libravdb-memory] plugins.slots.memory is "${memSlot}". ` +
          `Set it to "libravdb-memory" before enabling this plugin.`,
      );
    }
    if (memSlot === "none") {
      logger.info?.(
        "[libravdb-memory] plugins.slots.memory is \"none\"; " +
        "skipping memory capability, context engine, embedding providers, services, and hooks.",
      );
      registerMemoryCli(api, null, cfg, logger);
      return;
    }
    if (ctxSlot && ctxSlot !== MEMORY_ID && ctxSlot !== "legacy") {
      throw new Error(
        `[libravdb-memory] plugins.slots.contextEngine is "${ctxSlot}". ` +
          `Set it to "libravdb-memory" before enabling this plugin.`,
      );
    }
    if (!ctxSlot || ctxSlot === "legacy") {
      logger.warn?.(
        "[libravdb-memory] plugins.slots.contextEngine is unset or \"legacy\"; " +
        "set it to \"libravdb-memory\" for afterTurn ingestion to work.",
      );
    }
  }

  // Runtime creation:
  // - Lightweight modes (cli-metadata, setup-only): no runtime, CLI structure only.
  // - Discovery mode: runtime for lazy CLI loading, but no context engine.
  // - Every other mode (full, agent, gateway, channels, etc.): full runtime +
  //   context engine so durable memory ingest/recall works across all entrypoints.
  const runtimeOrNull = isLightweight
    ? null
    : createPluginRuntime(cfg, logger);

  // Rule store init — persists to plugin cache directory.
  if (runtimeOrNull && !isLightweight) {
    const cacheDir = ((api as unknown as Record<string, unknown>).cacheDir as string | undefined)
      ?? process.env.OPENCLAW_CACHE_DIR
      ?? (process.env.HOME || process.env.USERPROFILE || "") + "/.openclaw/cache";
    if (cacheDir) initRuleStore(cacheDir + "/libravdb", logger);
  }

  registerMemoryCli(api, runtimeOrNull, cfg, logger);

  const ownsMemorySlot = memSlot === MEMORY_ID;
  if (runtimeOrNull && ownsMemorySlot) {
    const memoryTools = createLibraVdbMemoryTools(runtimeOrNull.getClient, cfg, logger);
    api.registerTool?.((ctx) => memoryTools.createSearchTool(ctx), { names: ["memory_search"] });
    api.registerTool?.((ctx) => memoryTools.createGetTool(ctx), { names: ["memory_get"] });
  }

  // Recall tools: describe, expand, grep — available when the runtime exists.
  if (runtimeOrNull) {
    api.registerTool?.((ctx) => {
      const getClient = runtimeOrNull.getClient;
      const getSessionId = () => (ctx as Record<string, unknown>).sessionId as string | undefined;
      return createMemoryDescribeTool(getClient, getSessionId, logger);
    }, { names: ["memory_describe"] });
    api.registerTool?.((ctx) => {
      const getClient = runtimeOrNull.getClient;
      const getSessionKey = () => (ctx as Record<string, unknown>).sessionKey as string | undefined;
      const getSessionId = () => (ctx as Record<string, unknown>).sessionId as string | undefined;
      return createMemoryExpandTool(getClient, getSessionKey, logger, getSessionId);
    }, { names: ["memory_expand"] });
    api.registerTool?.((ctx) => {
      const getClient = runtimeOrNull.getClient;
      const getSessionId = () => (ctx as Record<string, unknown>).sessionId as string | undefined;
      return createMemoryGrepTool(getClient, getSessionId, logger);
    }, { names: ["memory_grep"] });
    api.registerTool?.((ctx) => {
      const getClient = runtimeOrNull.getClient;
      return createUpdateUserCardTool(getClient, logger);
    }, { names: ["update_user_card"] });
    api.registerTool?.((ctx) => {
      const getClient = runtimeOrNull.getClient;
      return createGetUserCardTool(getClient, logger);
    }, { names: ["get_user_card"] });
    api.registerTool?.((ctx) => {
      const getClient = runtimeOrNull.getClient;
      return createListUserCardsTool(getClient, logger);
    }, { names: ["list_user_cards"] });
    api.registerTool?.(() => createSetRuleTool(logger), { names: ["set_rule"] });
    api.registerTool?.(() => createGetRuleTool(logger), { names: ["get_rule"] });
    api.registerTool?.(() => createListRulesTool(logger), { names: ["list_rules"] });
    api.registerTool?.(() => createDeleteRuleTool(logger), { names: ["delete_rule"] });
  }

  if (isLightweight || isDiscovery) {
    if (!isLightweight) {
      // discovery: has runtime for CLI but skips durable memory hooks.
      // Context engine registration happens later when the framework
      // reloads the plugin in "full" mode for an actual session.
      logger.info?.(
        `LibraVDB: discovery mode — CLI registered, context engine deferred.`,
      );
    } else {
      logger.warn?.(
        `LibraVDB: registration mode is "${registrationMode}". ` +
        `Context engine hooks (bootstrap, ingest, afterTurn) are NOT registered. ` +
        `Memory will not be written automatically — only CLI commands are available.`,
      );
    }
    return;
  }

  // TypeScript can't narrow through the ternary, so re-bind and guard.
  const runtime = runtimeOrNull;
  if (!runtime) return; // unreachable but satisfies the type checker

  if (!memSlot) {
    logger.warn?.("[libravdb-memory] plugins.slots.memory is unset; set it to \"libravdb-memory\" for memory to work.");
  }
  if (!ctxSlot || ctxSlot === "legacy") {
    logger.warn?.("[libravdb-memory] plugins.slots.contextEngine is unset or \"legacy\"; set it to \"libravdb-memory\" for afterTurn ingestion to work.");
  }

  // Migrated from three legacy calls to a single registerMemoryCapability.
  api.registerMemoryCapability(MEMORY_ID, {
    promptBuilder: buildMemoryPromptSection(runtime.getClient, cfg),
    runtime: buildMemoryRuntimeBridge(runtime.getClient, cfg),
  });

  // Register embedding adapter IDs so OpenClaw can discover available
  // embedding backends for config resolution. Actual embeddings run inside
  // the vector service — these are declarative discovery entries only.
  const embeddingAdapters = [
    { id: "libravdb-gguf", transport: "local" as const, profile: cfg.embeddingProfile ?? "nomic-embed-text-v1.5" },
    { id: "libravdb-bundled", transport: "local" as const, profile: cfg.embeddingProfile ?? "nomic-embed-text-v1.5" },
    { id: "libravdb-onnx", transport: "local" as const, profile: cfg.fallbackProfile ?? "bge-small-en-v1.5" },
  ];
  for (const entry of embeddingAdapters) {
    api.registerMemoryEmbeddingProvider?.({
      id: entry.id,
      defaultModel: entry.profile,
      transport: entry.transport,
      async create(_options: Record<string, unknown>) {
        return {
          ok: false,
          error: `LibraVDB embedding is managed by the vector service. Use config embeddingBackend="${entry.id}" to select this backend.`,
        };
      },
    } as any);
  }

  api.registerContextEngine(
    MEMORY_ID,
    () => buildContextEngineFactory(runtime, cfg, logger),
  );

  // Register the daemon's extractive summarization as a pluggable
  // compaction backend. When agents.defaults.compaction.provider is
  // set to "libravdb-memory", the framework's compaction safeguard
  // delegates summarization here instead of burning LLM tokens.
  type CompactionProviderApi = { registerCompactionProvider?: (p: { id: string; label: string; summarize(params: { messages: unknown[] }): Promise<string> }) => void };
  (api as unknown as CompactionProviderApi).registerCompactionProvider?.({
    id: MEMORY_ID,
    label: "LibraVDB Extractive Summarization",
    async summarize({ messages }) {
      const client = await runtime.getClient();
      const result = await client.summarizeMessages({
        messages: messages.map((m) => normalizeKernelMessage(m as { role: string; content: unknown; id?: string })) as any,
        maxOutputTokens: 64,
      } as any);
      return result.summaryText;
    },
  });

  const markdownIngestion = createMarkdownIngestionHandle(cfg, runtime.getClient, logger);
  const dreamPromotion = createDreamPromotionHandle(cfg, runtime.getClient, logger);

  api.registerService?.({
    id: "libravdb-markdown-ingestion",
    async start() {
      try {
        await markdownIngestion.start();
      } catch (error) {
        logger.warn?.(`LibraVDB markdown ingestion failed to start: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async stop() {
      await markdownIngestion.stop();
    },
  });

  api.registerService?.({
    id: "libravdb-dream-promotion",
    async start() {
      try {
        await dreamPromotion.start();
      } catch (error) {
        logger.warn?.(`LibraVDB dream promotion failed to start: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async stop() {
      await dreamPromotion.stop();
    },
  });

  api.registerRuntimeLifecycle?.({
    id: "libravdb-shutdown",
    description: "Shut down the vector service runtime on terminal plugin cleanup",
    async cleanup(ctx) {
      if (shouldShutdownRuntimeForLifecycleCleanup(ctx.reason, ctx.sessionKey)) {
        logger.info?.(`LibraVDB ${ctx.reason} — shutting down runtime`);
        await runtime.shutdown();
      } else if (ctx.reason === "disable") {
        logger.info?.(
          "LibraVDB disable cleanup observed; preserving runtime for active context engine",
        );
      }
    },
  });

  // Capture trigger type for BeforeTurnKernel gating. Automated triggers
  // (heartbeat, cron, memory, overflow) skip semantic retrieval to save
  // an embedding call and RPC round trip on non-interactive turns.
  api.on("before_prompt_build", async (_event, ctx) => {
    const sessionId = (ctx as Record<string, unknown> | undefined)?.sessionId as string | undefined;
    const trigger = (ctx as Record<string, unknown> | undefined)?.trigger as string | undefined;
    if (sessionId) setSessionTrigger(sessionId, trigger);
  });

  // Phase 2 — inject speaker cards for non-main users in multi-speaker channels.
  const MULTI_SPEAKER_PROVIDERS = new Set([
    "discord", "telegram", "imessage", "slack",
    "whatsapp", "signal", "matrix", "irc",
  ]);

  // @ts-expect-error: api.on types declare void return, but the runtime
  // processes PluginHookBeforePromptBuildResult from before_prompt_build handlers.
  api.on("before_prompt_build", async (event: unknown, ctx: unknown) => {
    const c = ctx as Record<string, unknown>;
    const provider = c.messageProvider as string | undefined;
    if (!provider || !MULTI_SPEAKER_PROVIDERS.has(provider.toLowerCase())) return;

    const e = event as Record<string, unknown>;
    const messages = (e.messages ?? []) as Array<{ role: string; content: string | unknown[] }>;
    const speakers = extractSpeakers(messages);
    if (speakers.length === 0) return;

    const mainIdentity = resolveIdentity({
      configUserId: cfg.userId,
      identityPath: cfg.identityPath,
      sessionKey: c.sessionKey as string | undefined,
      logger,
      noAutoPersist: true,
    });
    const mainUserId = mainIdentity.userId.toLowerCase();
    const otherSpeakers = speakers.filter(s => s.name !== mainUserId);
    if (otherSpeakers.length === 0) return;

    try {
      const client = await runtime.getClient();
      const results = await Promise.all(
        otherSpeakers.map(async (speaker) => {
          try {
            const resp = await client.getUserCard({ userId: speaker.name });
            if (!resp.cardJson) return null;
            let card: string;
            try { card = JSON.parse(resp.cardJson).card ?? resp.cardJson; }
            catch { card = resp.cardJson; }
            if (!card || !card.trim()) return null;
            return `<speaker_context speaker="${speaker.displayName}">\nThe current speaker is ${speaker.displayName}:\n${card.trim()}\n</speaker_context>`;
          } catch { return null; }
        })
      );
      const validCards = results.filter((c): c is string => c !== null);
      if (validCards.length === 0) return;
      return { appendSystemContext: validCards.join("\n") };
    } catch (error) {
      logger.warn?.(
        `LibraVDB speaker card injection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  // Hard constraint rules — injected as prependSystemContext at the system
  // prompt level (AGENTS.md equivalent) so the model treats them as hard rules.
  // @ts-expect-error: api.on types declare void return, runtime processes hook results.
  api.on("before_prompt_build", async () => {
    const rulesText = buildRulesContext();
    if (!rulesText) return;
    return { prependSystemContext: rulesText };
  });

  // Rule enforcement — scan agent replies against rule keywords.
  // If a keyword match is found, the reply is replaced with a refusal.
  // @ts-expect-error: api.on types declare void return, runtime processes hook results.
  api.on("before_agent_reply", async (event, _ctx) => {
    const e = event as Record<string, unknown>;
    const cleanedBody = typeof e.cleanedBody === "string" ? e.cleanedBody : "";
    if (!cleanedBody) return;
    const violated = scanReply(cleanedBody);
    if (violated) {
      logger.warn?.(`LibraVDB reply blocked by rule "${violated.rule}" (${violated.id})`);
      return { handled: true, reply: { text: "I cannot answer that." }, reason: `blocked by rule: ${violated.rule}` };
    }
  });

  api.on("session_end", async (_event, ctx) => {
    const sessionId = (ctx as Record<string, unknown> | undefined)?.sessionId as string | undefined;
    if (sessionId) clearSessionTrigger(sessionId);
  });

  api.on("before_reset", createBeforeResetHook(runtime, logger));
  api.on("session_end", createSessionEndHook(runtime, logger));
  api.on("gateway_stop", async () => {
    await runtime.shutdown();
  });
}

export default definePluginEntry({
  id: MEMORY_ID,
  name: "LibraVDB Memory",
  description: "Persistent vector memory with three-tier hybrid scoring",
  kind: ["memory", "context-engine"],

  register,
});
