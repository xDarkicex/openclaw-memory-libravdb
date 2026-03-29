import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerMemoryCli } from "./cli.js";
import { buildContextEngineFactory } from "./context-engine.js";
import { buildMemoryPromptSection } from "./memory-provider.js";
import { createRecallCache } from "./recall-cache.js";
import { createPluginRuntime } from "./plugin-runtime.js";
import type { PluginConfig, SearchResult } from "./types.js";

export default definePluginEntry({
  id: "libravdb-memory",
  name: "LibraVDB Memory",
  description: "Persistent vector memory with three-tier hybrid scoring",
  kind: "memory",

  register(api: OpenClawPluginApi) {
    const cfg = api.pluginConfig as PluginConfig;
    const recallCache = createRecallCache<SearchResult>();
    const runtime = createPluginRuntime(cfg, api.logger ?? console);

    registerMemoryCli(api, runtime, cfg, api.logger ?? console);
    api.registerContextEngine("libravdb-memory", () =>
      buildContextEngineFactory(runtime.getRpc, cfg, recallCache),
    );
    api.registerMemoryPromptSection(buildMemoryPromptSection());
    api.on("gateway_stop", () => runtime.shutdown());
  },
});
