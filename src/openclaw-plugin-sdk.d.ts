declare module "openclaw/plugin-sdk/plugin-entry" {
  interface OpenClawCliCommand {
    commands?: OpenClawCliCommand[];
    command(name: string): OpenClawCliCommand;
    description(text: string): OpenClawCliCommand;
    option(flags: string, description: string): OpenClawCliCommand;
    requiredOption?(flags: string, description: string): OpenClawCliCommand;
    action(handler: (opts?: Record<string, unknown>) => unknown): OpenClawCliCommand;
    name?(): string;
  }

  export interface OpenClawPluginApi {
    pluginConfig: unknown;
    logger?: {
      debug?(message: string): void;
      error(message: string): void;
      info?(message: string): void;
      warn?(message: string): void;
    };
    registerContextEngine(id: string, factory: () => unknown): void;
    registerMemoryPromptSection(builder: unknown): void;
    registerMemoryFlushPlan?(resolver: unknown): void;
    registerMemoryRuntime?(runtime: unknown): void;
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
    on(event: string, handler: (...args: unknown[]) => void | Promise<void>, opts?: { priority?: number }): void;
  }

  export function definePluginEntry(entry: {
    id: string;
    name: string;
    description: string;
    kind?: "memory" | "context-engine";
    configSchema?: unknown;
    register(api: OpenClawPluginApi): void | Promise<void>;
  }): {
    id: string;
    name: string;
    description: string;
    kind?: "memory" | "context-engine";
    configSchema?: unknown;
    register(api: OpenClawPluginApi): void | Promise<void>;
  };
}
