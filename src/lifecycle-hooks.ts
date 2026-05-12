import type { PluginRuntime } from "./plugin-runtime.js";
import { formatError } from "./format-error.js";
import type { LoggerLike } from "./types.js";

type AgentContext = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir?: string;
};

type BeforeResetEvent = {
  sessionFile?: string;
  messages?: unknown[];
  reason?: string;
};

type SessionEndEvent = {
  sessionId?: string;
  sessionKey?: string;
  messageCount?: number;
  durationMs?: number;
  reason?: string;
  sessionFile?: string;
  transcriptArchived?: boolean;
  nextSessionId?: string;
  nextSessionKey?: string;
};

export function createBeforeResetHook(runtime: PluginRuntime, logger: LoggerLike = console) {
  return async (event: unknown, ctx: unknown): Promise<void> => {
    const typedEvent = asBeforeResetEvent(event);
    const typedCtx = asAgentContext(ctx);
    try {
      await runtime.emitLifecycleHint({
        hook: "before_reset",
        reason: typedEvent.reason,
        sessionFile: typedEvent.sessionFile,
        sessionId: typedCtx.sessionId,
        sessionKey: typedCtx.sessionKey,
        agentId: typedCtx.agentId,
        workspaceDir: typedCtx.workspaceDir,
        messageCount: Array.isArray(typedEvent.messages) ? typedEvent.messages.length : undefined,
      });
    } catch (error) {
      logger.warn?.(`LibraVDB before_reset hint failed: ${formatError(error)}`);
    }
  };
}

export function createSessionEndHook(runtime: PluginRuntime, logger: LoggerLike = console) {
  return async (event: unknown, ctx: unknown): Promise<void> => {
    const typedEvent = asSessionEndEvent(event);
    const typedCtx = asAgentContext(ctx);
    const sessionId = typedEvent.sessionId ?? typedCtx.sessionId;
    const sessionKey = typedEvent.sessionKey ?? typedCtx.sessionKey;
    try {
      logger.info?.(
        `LibraVDB session_end sessionId=${sessionId ?? "(unknown)"} ` +
        `messageCount=${typedEvent.messageCount ?? "?"} ` +
        `durationMs=${typedEvent.durationMs ?? "?"} ` +
        `reason=${typedEvent.reason ?? "unknown"}`,
      );
      await runtime.emitLifecycleHint({
        hook: "session_end",
        reason: typedEvent.reason,
        sessionFile: typedEvent.sessionFile,
        sessionId,
        sessionKey,
        agentId: typedCtx.agentId,
        workspaceDir: typedCtx.workspaceDir,
        messageCount: typedEvent.messageCount,
        durationMs: typedEvent.durationMs,
        transcriptArchived: typedEvent.transcriptArchived,
        nextSessionId: typedEvent.nextSessionId,
        nextSessionKey: typedEvent.nextSessionKey,
      });
    } catch (error) {
      logger.warn?.(`LibraVDB session_end hint failed: ${formatError(error)}`);
    }
  };
}

function asAgentContext(value: unknown): AgentContext {
  return isRecord(value) ? value as AgentContext : {};
}

function asBeforeResetEvent(value: unknown): BeforeResetEvent {
  return isRecord(value) ? value as BeforeResetEvent : {};
}

function asSessionEndEvent(value: unknown): SessionEndEvent {
  return isRecord(value) ? value as SessionEndEvent : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
