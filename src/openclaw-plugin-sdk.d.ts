/**
 * Minimal structural types for OpenClaw plugin SDK surfaces used by this plugin.
 *
 * Derivation: tracked against openclaw SDK as of 2026.5.x (2026.4.11 installed).
 * The SDK ships full types internally (dist/plugin-sdk/src/plugins/types.d.ts) but
 * only a subset are re-exported from public subpaths. This file bridges the gap.
 *
 * Types that COULD be replaced with direct SDK imports if they become public:
 *   - MemoryPromptSectionBuilder (not re-exported from plugin-entry; lives in
 *     memory-state which has no public subpath export)
 *   - OpenClawCliCommand (SDK uses Commander.js Command directly; we type a
 *     structural subset that Commander satisfies at runtime)
 *
 * Types that DO come from SDK public exports but we shadow locally:
 *   - definePluginEntry (available at openclaw/plugin-sdk/plugin-entry)
 *   - OpenClawPluginApi (available at openclaw/plugin-sdk/plugin-entry)
 *     ^ We shadow these because our registerCli shape differs from the SDK's
 *       Commander.js Command type. Revisit when we align CLI typing.
 *
 * Re-validation: run `npx tsc --noEmit` after openclaw version bumps.
 */

declare module "openclaw/plugin-sdk/plugin-entry" {
  export type MemoryPromptSectionBuilder = (params: {
    availableTools: Set<string>;
    citationsMode?: string;
  }) => string[];

  // Minimal structural types for Commander.js program surface.
  // The SDK types program: Command directly from Commander; we use a
  // structural subset that Commander satisfies at runtime.
  interface OpenClawCliCommand {
    commands?: OpenClawCliCommand[];
    command(name: string): OpenClawCliCommand;
    description(text: string): OpenClawCliCommand;
    argument?(name: string, description: string): OpenClawCliCommand;
    option(flags: string, description: string): OpenClawCliCommand;
    requiredOption?(flags: string, description: string): OpenClawCliCommand;
    action(handler: (...args: unknown[]) => unknown): OpenClawCliCommand;
    name?(): string;
  }

  interface PluginsSlots {
    memory?: string;
    contextEngine?: string;
  }

  interface PluginsConfig {
    slots?: PluginsSlots;
  }

  interface OpenClawConfig {
    plugins?: PluginsConfig;
  }

  type PluginRegistrationMode = string;

  interface OpenClawPluginToolContext {
    config?: OpenClawConfig;
    runtimeConfig?: OpenClawConfig;
    workspaceDir?: string;
    agentDir?: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    sandboxed?: boolean;
  }

  interface OpenClawPluginToolResult {
    content: Array<{
      type: "text";
      text: string;
    }>;
    details?: unknown;
  }

  interface OpenClawPluginTool {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    execute(toolCallId: string, params: unknown): OpenClawPluginToolResult | Promise<OpenClawPluginToolResult>;
  }

  type OpenClawPluginToolFactory = (
    ctx: OpenClawPluginToolContext,
  ) => OpenClawPluginTool | OpenClawPluginTool[] | null | undefined;

  export interface OpenClawPluginApi {
    id: string;
    name: string;
    version?: string;
    description?: string;
    source: string;
    rootDir?: string;
    registrationMode: PluginRegistrationMode;
    config: OpenClawConfig;
    pluginConfig: Record<string, unknown>;
    logger?: {
      debug?(message: string): void;
      error(message: string): void;
      info?(message: string): void;
      warn?(message: string): void;
    };
    registerTool(
      tool: OpenClawPluginTool | OpenClawPluginToolFactory,
      opts?: {
        name?: string;
        names?: string[];
        optional?: boolean;
      },
    ): void;
    registerContextEngine(id: string, factory: () => unknown): void;
    registerMemoryCapability(id: string, capability: {
      promptBuilder?: MemoryPromptSectionBuilder;
      runtime?: unknown;
    }): void;
    registerMemoryPromptSection?(builder: MemoryPromptSectionBuilder): void;
    registerMemoryFlushPlan?(resolver: unknown): void;
    registerMemoryRuntime?(runtime: unknown): void;
    registerMemoryEmbeddingProvider?(provider: unknown): void;
    registerCli?(
      builder: (ctx: { program: OpenClawCliCommand }) => void,
      opts?: {
        commands?: string[];
        descriptors?: Array<{
          name: string;
          description: string;
          hasSubcommands: boolean;
        }>;
      },
    ): void;
    registerService?(service: {
      id: string;
      start(ctx: unknown): void | Promise<void>;
      stop?(ctx: unknown): void | Promise<void>;
    }): void;
    registerRuntimeLifecycle?(registration: {
      id: string;
      description?: string;
      cleanup(ctx: { reason: "disable" | "reset" | "delete" | "restart" }): void | Promise<void>;
    }): void;
    on(event: string, handler: (...args: unknown[]) => void | Promise<void>, opts?: { priority?: number }): void;
  }

  export function definePluginEntry(entry: {
    id: string;
    name: string;
    description: string;
    kind?: "memory" | "context-engine" | Array<"memory" | "context-engine">;
    configSchema?: unknown;
    register(api: OpenClawPluginApi): void | Promise<void>;
  }): {
    id: string;
    name: string;
    description: string;
    kind?: "memory" | "context-engine" | Array<"memory" | "context-engine">;
    configSchema?: unknown;
    register(api: OpenClawPluginApi): void | Promise<void>;
  };
}
