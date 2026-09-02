import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export const PLUGIN_ID = "libravdb-memory";

export const MEMORY_CLI_DESCRIPTOR = {
  name: "libravdb",
  description: "Manage LibraVDB memory",
  hasSubcommands: true,
} as const;

export function isMemorySlotSelected(api: Pick<OpenClawPluginApi, "config">): boolean {
  const slots = api.config?.plugins?.slots;
  return slots?.memory === PLUGIN_ID;
}

export function registerMemoryCliMetadata(
  api: Pick<OpenClawPluginApi, "config" | "registerCli">,
): void {
  if (!isMemorySlotSelected(api)) {
    return;
  }
  api.registerCli?.(() => {}, {
    descriptors: [MEMORY_CLI_DESCRIPTOR],
  });
}
