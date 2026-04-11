import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerMemoryCli } from "./cli.js";
import { buildContextEngineFactory } from "./context-engine.js";
import { createBeforeResetHook, createSessionEndHook } from "./lifecycle-hooks.js";
import { createDreamPromotionHandle } from "./dream-promotion.js";
import { createMarkdownIngestionHandle } from "./markdown-ingest.js";
import { buildMemoryPromptSection } from "./memory-provider.js";
import { buildMemoryRuntimeBridge } from "./memory-runtime.js";
import { createRecallCache } from "./recall-cache.js";
import { createPluginRuntime } from "./plugin-runtime.js";
import type { PluginConfig, SearchResult } from "./types.js";

export default definePluginEntry({
  id: "libravdb-memory",
  name: "LibraVDB Memory",
  description: "Persistent vector memory with three-tier hybrid scoring",
  kind: ["memory", "context-engine"],

  register(api: OpenClawPluginApi) {
    const cfg = api.pluginConfig as PluginConfig;
    const recallCache = createRecallCache<SearchResult>();
    const runtime = createPluginRuntime(cfg, api.logger ?? console);
    const markdownIngestion = createMarkdownIngestionHandle(cfg, runtime.getRpc, api.logger ?? console);
    const dreamPromotion = createDreamPromotionHandle(cfg, runtime.getRpc, api.logger ?? console);

    void markdownIngestion.start().catch((error) => {
      api.logger?.warn?.(`LibraVDB markdown ingestion failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
    void dreamPromotion.start().catch((error) => {
      api.logger?.warn?.(`LibraVDB dream promotion failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });

    registerMemoryCli(api, runtime, cfg, api.logger ?? console);
    api.registerContextEngine("libravdb-memory", () =>
      buildContextEngineFactory(runtime.getRpc, cfg, recallCache),
    );
    api.registerMemoryPromptSection(buildMemoryPromptSection(runtime.getRpc, cfg, recallCache));
    api.registerMemoryRuntime?.(buildMemoryRuntimeBridge(runtime.getRpc, cfg));
    api.on("before_reset", createBeforeResetHook(runtime, api.logger ?? console));
    api.on("session_end", createSessionEndHook(runtime, api.logger ?? console));
    api.on("gateway_stop", async () => {
      await dreamPromotion.stop();
      await markdownIngestion.stop();
      await runtime.shutdown();
    });
  },
});
