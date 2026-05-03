import test from "node:test";
import assert from "node:assert/strict";

import { buildContextEngineFactory as createContextEngineFactory } from "../../src/context-engine.js";
import { createMemoryLogger } from "../helpers/logger.js";
import type { LoggerLike, PluginConfig, SearchResult } from "../../src/types.js";

const NOOP_LOGGER: LoggerLike = {
  error() {},
  info() {},
  warn() {},
};

/**
 * StaticContractRpc replaces the complex, logic-heavy mock with a strict API boundary.
 * It tracks outgoing calls and returns predefined static responses matching rpc_pb.d.ts,
 * ensuring the TS wrapper is tested purely as a transport layer.
 */
class StaticContractRpc {
  public calls: Array<{ method: string; params: any }> = [];
  public mockResponses = new Map<string, any>();

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });

    if (this.mockResponses.has(method)) {
      const mockValue = this.mockResponses.get(method);
      if (mockValue instanceof Error) {
        throw mockValue;
      }
      return mockValue as T;
    }

    // Default static success responses matching rpc_pb.d.ts
    switch (method) {
      case "bootstrap_session_kernel":
      case "ingest_message_kernel":
      case "after_turn_kernel":
      case "bump_access_counts":
      case "flush":
      case "health":
        return { ok: true } as unknown as T;
      case "assemble_context_internal":
        return {
          messages: [],
          estimatedTokens: 0,
          systemPromptAddition: "",
          debug: { recoveryTriggerFired: false, crossSessionRawRecovery: false },
        } as unknown as T;
      case "compact_session":
        return { didCompact: true } as unknown as T;
      default:
        throw new Error(`Static mock missing default response for method: ${method}`);
    }
  }

  // Helper to get the most recent call for a specific method
  getLastCall(method: string): any {
    const reversed = [...this.calls].reverse();
    return reversed.find((c) => c.method === method)?.params || null;
  }
}

function buildContextEngineFactory(
  getRpc: any,
  cfg: Parameters<typeof createContextEngineFactory>[1],
  logger: LoggerLike = NOOP_LOGGER,
) {
  const runtime = {
    getRpc,
    getKernel: async () => null,
    emitLifecycleHint: async () => {},
    onShutdown: () => {},
    shutdown: async () => {},
  } as unknown as import("../../src/plugin-runtime.js").PluginRuntime;
  return createContextEngineFactory(runtime, cfg, logger);
}

test("bootstrap correctly forwards session arguments to the RPC layer", async () => {
  const rpc = new StaticContractRpc();
  const cfg: PluginConfig = { rpcTimeoutMs: 1000 };

  const context = buildContextEngineFactory(async () => rpc as never, cfg);

  await context.bootstrap({
    sessionId: "test-session",
    sessionKey: "test-key",
    userId: "test-user",
  });

  const params = rpc.getLastCall("bootstrap_session_kernel");
  assert.ok(params, "Expected bootstrap_session_kernel to be called");
  assert.equal(params.sessionId, "test-session");
  assert.equal(params.sessionKey, "test-key");
  assert.equal(params.userId, "test-user");
});

test("ingest correctly forwards message payload to the RPC layer", async () => {
  const rpc = new StaticContractRpc();
  const cfg: PluginConfig = { rpcTimeoutMs: 1000 };

  const context = buildContextEngineFactory(async () => rpc as never, cfg);

  await context.ingest({
    sessionId: "test-session",
    message: { role: "user", content: "hello world", id: "msg-123" },
    isHeartbeat: true,
  });

  const params = rpc.getLastCall("ingest_message_kernel");
  assert.ok(params, "Expected ingest_message_kernel to be called");
  assert.equal(params.sessionId, "test-session");
  assert.equal(params.isHeartbeat, true);
  assert.deepEqual(params.message, { role: "user", content: "hello world", id: "msg-123" });
});

test("assemble passes correct configuration mapping and returns expected payload", async () => {
  const rpc = new StaticContractRpc();

  rpc.mockResponses.set("assemble_context_internal", {
    messages: [{ role: "assistant", content: "Mocked recalled context" }],
    estimatedTokens: 150,
    systemPromptAddition: "<recalled_memories>static memory data</recalled_memories>",
    debug: { recoveryTriggerFired: true, crossSessionRawRecovery: false },
  });

  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    topK: 12,
    tokenBudgetFraction: 0.8,
    useSessionRecallProjection: true,
    continuityMinTurns: 4,
  };

  const context = buildContextEngineFactory(async () => rpc as never, cfg);

  const assembled = await context.assemble({
    sessionId: "test-session",
    userId: "test-user",
    messages: [{ role: "user", content: "what do you remember?" }],
    tokenBudget: 1000,
    prompt: "system prompt text",
  });

  // Verify outbound payload mapping
  const params = rpc.getLastCall("assemble_context_internal");
  assert.ok(params, "Expected assemble_context_internal to be called");
  assert.equal(params.sessionId, "test-session");
  assert.equal(params.userId, "test-user");
  assert.equal(params.tokenBudget, 1000);
  assert.equal(params.prompt, "system prompt text");
  assert.deepEqual(params.messages, [{ role: "user", content: "what do you remember?" }]);

  // Verify configuration overrides were mapped correctly
  assert.equal(params.config.topK, 12);
  assert.equal(params.config.tokenBudgetFraction, 0.8);
  assert.equal(params.config.useSessionRecallProjection, true);
  assert.equal(params.config.continuityMinTurns, 4);
  assert.equal(params.config.compactThreshold, 800);
  assert.equal(params.emitDebug, true);

  // Verify inbound response handling
  assert.equal(assembled.estimatedTokens, 150);
  assert.equal(assembled.systemPromptAddition, "<recalled_memories>static memory data</recalled_memories>");
  assert.deepEqual(assembled.messages, [{ role: "assistant", content: "Mocked recalled context" }]);
  assert.equal(assembled.debug?.recoveryTriggerFired, true);
});

test("assemble clamps oversized daemon context to token budget", async () => {
  const rpc = new StaticContractRpc();
  rpc.mockResponses.set("assemble_context_internal", {
    messages: [
      { role: "assistant", content: "A".repeat(3200) },
      { role: "assistant", content: "B".repeat(3200) },
    ],
    estimatedTokens: 5000,
    systemPromptAddition: "x",
    debug: { recoveryTriggerFired: false, crossSessionRawRecovery: false },
  });

  const cfg: PluginConfig = { rpcTimeoutMs: 1000 };
  const context = buildContextEngineFactory(async () => rpc as never, cfg);

  const assembled = await context.assemble({
    sessionId: "test-session",
    userId: "test-user",
    messages: [{ role: "user", content: "hello" }],
    tokenBudget: 512,
  });

  assert.ok(assembled.estimatedTokens <= 256);
  assert.ok(assembled.messages.length <= 1);
});

test("assemble fail-closed on sidecar errors with budget-clamped fallback", async () => {
  const rpc = new StaticContractRpc();
  rpc.mockResponses.set("assemble_context_internal", new Error("Sidecar socket unavailable"));

  const cfg: PluginConfig = { rpcTimeoutMs: 1000, compactThreshold: 100000 };
  const context = buildContextEngineFactory(async () => rpc as never, cfg);

  const assembled = await context.assemble({
    sessionId: "test-session",
    userId: "test-user",
    messages: [
      { role: "user", content: "U".repeat(2200) },
      { role: "assistant", content: "A".repeat(2200) },
    ],
    tokenBudget: 512,
  });

  assert.ok(assembled.estimatedTokens <= 256);
  assert.ok(assembled.messages.length >= 1);
  assert.equal(assembled.systemPromptAddition, "");
});

test("assemble triggers force compaction at dynamic 80% threshold before daemon assembly", async () => {
  const rpc = new StaticContractRpc();
  rpc.mockResponses.set("compact_session", { didCompact: true });
  rpc.mockResponses.set("assemble_context_internal", {
    messages: [{ role: "assistant", content: "ok" }],
    estimatedTokens: 32,
    systemPromptAddition: "",
  });

  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    compactionThresholdFraction: 0.8,
  };
  const logger = createMemoryLogger();
  const context = buildContextEngineFactory(async () => rpc as never, cfg, logger);

  const assembled = await context.assemble({
    sessionId: "test-session",
    userId: "test-user",
    messages: [{ role: "assistant", content: "X".repeat(4000) }],
    tokenBudget: 1000,
  });

  const compactParams = rpc.getLastCall("compact_session");
  assert.ok(compactParams, "Expected compact_session to be called");
  assert.equal(compactParams.sessionId, "test-session");
  assert.equal(compactParams.force, true);
  assert.equal(compactParams.targetSize, 799);
  assert.equal(compactParams.currentTokenCount, 1008);

  const assembleParams = rpc.getLastCall("assemble_context_internal");
  assert.ok(assembleParams, "Expected assemble_context_internal to be called after compaction");
  assert.equal(assembleParams.config.compactThreshold, 800);
  assert.equal(assembled.messages[0]?.content, "ok");
  assert.equal(logger.warns.length, 0);
  assert.match(logger.infos[0] ?? "", /predictive compaction trigger phase=assemble/);
  assert.match(logger.infos[1] ?? "", /predictive compaction completed phase=assemble/);
});

test("assemble prefers authoritative currentTokenCount for predictive compaction", async () => {
  const rpc = new StaticContractRpc();
  rpc.mockResponses.set("compact_session", { didCompact: true });
  rpc.mockResponses.set("assemble_context_internal", {
    messages: [{ role: "assistant", content: "ok" }],
    estimatedTokens: 32,
    systemPromptAddition: "",
  });

  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    compactionThresholdFraction: 0.8,
  };
  const context = buildContextEngineFactory(async () => rpc as never, cfg);

  await context.assemble({
    sessionId: "test-session",
    userId: "test-user",
    messages: [{ role: "assistant", content: "small" }],
    tokenBudget: 1000,
    currentTokenCount: 900,
  });

  const compactParams = rpc.getLastCall("compact_session");
  assert.ok(compactParams, "Expected compact_session to be called");
  assert.equal(compactParams.currentTokenCount, 900);
  assert.equal(compactParams.targetSize, 799);
});

test("assemble proceeds to assembly when server legitimately declines compaction", async () => {
  const rpc = new StaticContractRpc();
  rpc.mockResponses.set("compact_session", { didCompact: false });
  rpc.mockResponses.set("assemble_context_internal", {
    messages: [{ role: "assistant", content: "recalled" }],
    estimatedTokens: 40,
    systemPromptAddition: "<recalled>x</recalled>",
  });

  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    compactionThresholdFraction: 0.8,
  };
  const logger = createMemoryLogger();
  const context = buildContextEngineFactory(async () => rpc as never, cfg, logger);

  const assembled = await context.assemble({
    sessionId: "test-session",
    userId: "test-user",
    messages: [{ role: "assistant", content: "X".repeat(4000) }],
    tokenBudget: 1000,
  });

  const assembleParams = rpc.getLastCall("assemble_context_internal");
  assert.ok(assembleParams, "assemble_context_internal must be called when compaction declines");
  assert.equal(assembled.messages[0]?.content, "recalled");
  assert.equal(assembled.systemPromptAddition, "<recalled>x</recalled>");
  assert.match(logger.warns[0] ?? "", /did not compact.*phase=assemble/);
});

test("assemble blocks daemon assembly when predictive compaction fails", async () => {
  const rpc = new StaticContractRpc();
  rpc.mockResponses.set("compact_session", new Error("transaction conflict"));
  rpc.mockResponses.set("assemble_context_internal", {
    messages: [{ role: "assistant", content: "should-not-be-used" }],
    estimatedTokens: 9999,
    systemPromptAddition: "x",
  });

  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    compactionThresholdFraction: 0.8,
  };
  const context = buildContextEngineFactory(async () => rpc as never, cfg);

  const assembled = await context.assemble({
    sessionId: "test-session",
    userId: "test-user",
    messages: [{ role: "assistant", content: "Y".repeat(4000) }],
    tokenBudget: 1000,
  });

  assert.ok(assembled.estimatedTokens <= 744);
  assert.equal(assembled.systemPromptAddition, "");
  const assembleCalls = rpc.calls.filter((call) => call.method === "assemble_context_internal");
  assert.equal(assembleCalls.length, 0, "assemble_context_internal must be blocked on compaction failure");
});

test("compact maps host budget requests onto legacy sidecar fields", async () => {
  const rpc = new StaticContractRpc();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    continuityMinTurns: 4,
    continuityTailBudgetTokens: 640,
    continuityPriorContextTokens: 320,
  };

  const context = buildContextEngineFactory(async () => rpc as never, cfg);

  await context.compact({
    sessionId: "test-session",
    force: true,
    tokenBudget: 2048,
  });

  const params = rpc.getLastCall("compact_session");
  assert.ok(params, "Expected compact_session to be called");
  assert.equal(params.sessionId, "test-session");
  assert.equal(params.force, true);
  assert.equal(params.targetSize, 2048);
  assert.equal(params.continuityMinTurns, 4);
  assert.equal(params.continuityTailBudgetTokens, 640);
  assert.equal(params.continuityPriorContextTokens, 320);
});

test("compact normalizes daemon compact response into SDK CompactResult", async () => {
  const rpc = new StaticContractRpc();
  rpc.mockResponses.set("compact_session", {
    didCompact: true,
    clustersFormed: 2,
    clustersDeclined: 1,
    turnsRemoved: 7,
    summaryMethod: "extractive",
    meanConfidence: 0.91,
  });

  const cfg: PluginConfig = { rpcTimeoutMs: 1000 };
  const context = buildContextEngineFactory(async () => rpc as never, cfg);

  const result = await context.compact({
    sessionId: "test-session",
    tokenBudget: 2048,
    currentTokenCount: 12345,
  });

  const params = rpc.getLastCall("compact_session");
  assert.ok(params, "Expected compact_session to be called");
  assert.equal(params.currentTokenCount, 12345);
  assert.equal(result.ok, true);
  assert.equal(result.compacted, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.result?.summary, "extractive");
  assert.equal(result.result?.tokensBefore, 12345);
  assert.deepEqual(result.result?.details, {
    clustersFormed: 2,
    clustersDeclined: 1,
    turnsRemoved: 7,
    summaryMethod: "extractive",
    meanConfidence: 0.91,
  });
});

test("compact rejects empty sessionId to prevent accidental session rollover", async () => {
  const rpc = new StaticContractRpc();
  const cfg: PluginConfig = { rpcTimeoutMs: 1000 };
  const context = buildContextEngineFactory(async () => rpc as never, cfg);

  await assert.rejects(
    context.compact({
      sessionId: " ",
      tokenBudget: 2048,
    }),
    /requires a non-empty sessionId/i,
  );
  assert.equal(rpc.getLastCall("compact_session"), null);
});

test("compact omits invalid currentTokenCount values from the wire request", async () => {
  const rpc = new StaticContractRpc();
  const cfg: PluginConfig = { rpcTimeoutMs: 1000 };
  const context = buildContextEngineFactory(async () => rpc as never, cfg);

  await context.compact({
    sessionId: "test-session",
    tokenBudget: 2048,
    currentTokenCount: Number.NaN,
  });

  const params = rpc.getLastCall("compact_session");
  assert.ok(params, "Expected compact_session to be called");
  assert.equal("currentTokenCount" in params, false);
});

test("afterTurn forwards only daemon-relevant fields, strips prePromptMessageCount", async () => {
  const rpc = new StaticContractRpc();
  const cfg: PluginConfig = { rpcTimeoutMs: 1000 };

  const context = buildContextEngineFactory(async () => rpc as never, cfg);

  const mockMessages = [
    { role: "user", content: "m1" },
    { role: "assistant", content: "m2" },
  ];

  await context.afterTurn({
    sessionId: "test-session",
    userId: "test-user",
    messages: mockMessages,
    prePromptMessageCount: 1,
    isHeartbeat: false,
  });

  const params = rpc.getLastCall("after_turn_kernel");
  assert.ok(params, "Expected after_turn_kernel to be called");
  assert.equal(params.sessionId, "test-session");
  assert.equal(params.userId, "test-user");
  assert.equal("prePromptMessageCount" in params, false, "prePromptMessageCount must not leak to daemon — daemon defaults to 0 and uses content-hash dedup");
  assert.equal(params.isHeartbeat, false);
  assert.deepEqual(params.messages, mockMessages);
});

test("afterTurn triggers predictive compaction from runtimeContext currentTokenCount", async () => {
  const rpc = new StaticContractRpc();
  rpc.mockResponses.set("compact_session", { didCompact: true });
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    compactionThresholdFraction: 0.8,
  };
  const logger = createMemoryLogger();

  const context = buildContextEngineFactory(async () => rpc as never, cfg, logger);

  await context.afterTurn({
    sessionId: "test-session",
    userId: "test-user",
    messages: [
      { role: "user", content: "remember this" },
      { role: "assistant", content: "small" },
    ],
    prePromptMessageCount: 1,
    tokenBudget: 1000,
    runtimeContext: { currentTokenCount: 900 },
  });

  assert.deepEqual(
    rpc.calls.map((call) => call.method),
    ["after_turn_kernel", "compact_session"],
  );

  const compactParams = rpc.getLastCall("compact_session");
  assert.ok(compactParams, "Expected compact_session to be called");
  assert.equal(compactParams.currentTokenCount, 900);
  assert.equal(compactParams.targetSize, 799);
  assert.equal(logger.warns.length, 0);
  assert.ok(logger.infos.some((message) => /predictive compaction trigger phase=afterTurn/.test(message)));
  assert.ok(logger.infos.some((message) => /predictive compaction completed phase=afterTurn/.test(message)));
});

test("afterTurn does not trigger predictive compaction without authoritative currentTokenCount", async () => {
  const rpc = new StaticContractRpc();
  const cfg: PluginConfig = {
    rpcTimeoutMs: 1000,
    compactionThresholdFraction: 0.8,
  };

  const context = buildContextEngineFactory(async () => rpc as never, cfg);

  await context.afterTurn({
    sessionId: "test-session",
    userId: "test-user",
    messages: [
      { role: "user", content: "remember this" },
      { role: "assistant", content: "small" },
    ],
    prePromptMessageCount: 1,
    tokenBudget: 1000,
    runtimeContext: { currentTokenCount: Number.NaN },
  });

  assert.deepEqual(
    rpc.calls.map((call) => call.method),
    ["after_turn_kernel"],
  );
  assert.equal(rpc.getLastCall("compact_session"), null);
});
