import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerMemoryCli } from "./cli.js";
import { registerMemoryCliMetadata } from "./cli-descriptors.js";
import { buildContextEngineFactory } from "./context-engine.js";
import { createBeforeResetHook, createSessionEndHook } from "./lifecycle-hooks.js";
import { createDreamPromotionHandle } from "./dream-promotion.js";
import { createMarkdownIngestionHandle } from "./markdown-ingest.js";
import { buildMemoryPromptSection } from "./memory-provider.js";
import { buildMemoryRuntimeBridge } from "./memory-runtime.js";
import { createPluginRuntime } from "./plugin-runtime.js";
import type { PluginConfig } from "./types.js";

export const MEMORY_ID = "libravdb-memory";

const LIGHTWEIGHT_MODES = new Set(["cli-metadata", "setup-only"]);
const RUNTIME_CLEANUP_SHUTDOWN_REASONS = new Set(["delete", "restart"]);

export function shouldShutdownRuntimeForLifecycleCleanup(reason: string): boolean {
  return RUNTIME_CLEANUP_SHUTDOWN_REASONS.has(reason);
}

export function register(api: OpenClawPluginApi) {
  const registrationMode = api.registrationMode;
  const logger = api.logger ?? console;

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
  }

  // Runtime creation:
  // - Lightweight modes (cli-metadata, setup-only): no runtime, CLI structure only.
  // - Discovery mode: runtime for lazy CLI loading, but no context engine.
  // - Every other mode (full, agent, gateway, channels, etc.): full runtime +
  //   context engine so durable memory ingest/recall works across all entrypoints.
  const runtimeOrNull = isLightweight
    ? null
    : createPluginRuntime(cfg, logger);
  registerMemoryCli(api, runtimeOrNull, cfg, logger);

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

  // Migrated from three legacy calls to a single registerMemoryCapability.
  api.registerMemoryCapability(MEMORY_ID, {
    promptBuilder: buildMemoryPromptSection(runtime.getRpc, cfg),
    runtime: buildMemoryRuntimeBridge(runtime.getRpc, cfg),
  });

  // Register embedding adapter IDs so OpenClaw can discover available
  // embedding backends for config resolution. Actual embeddings run inside
  // the vector service — these are declarative discovery entries only.
  const embeddingAdapters = [
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
    });
  }

  api.registerContextEngine(
    MEMORY_ID,
    () => buildContextEngineFactory(runtime, cfg, api.logger ?? console),
  );

  const markdownIngestion = createMarkdownIngestionHandle(cfg, runtime.getRpc, api.logger ?? console);
  const dreamPromotion = createDreamPromotionHandle(cfg, runtime.getRpc, api.logger ?? console);

  api.registerService?.({
    id: "libravdb-markdown-ingestion",
    async start() {
      try {
        await markdownIngestion.start();
      } catch (error) {
        api.logger?.warn?.(`LibraVDB markdown ingestion failed to start: ${error instanceof Error ? error.message : String(error)}`);
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
        api.logger?.warn?.(`LibraVDB dream promotion failed to start: ${error instanceof Error ? error.message : String(error)}`);
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
      if (shouldShutdownRuntimeForLifecycleCleanup(ctx.reason)) {
        logger.info?.(`LibraVDB ${ctx.reason} — shutting down runtime`);
        await runtime.shutdown();
      } else if (ctx.reason === "disable") {
        logger.info?.(
          "LibraVDB disable cleanup observed; preserving runtime for active context engine",
        );
      }
    },
  });

  api.on("before_reset", createBeforeResetHook(runtime, api.logger ?? console));
  api.on("session_end", createSessionEndHook(runtime, api.logger ?? console));
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
