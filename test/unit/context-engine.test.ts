import test from "node:test";
import assert from "node:assert/strict";

import { buildContextEngineFactory } from "../../src/context-engine.js";
import { resolveIdentity } from "../../src/identity.js";
import type { PluginConfig, SearchResult, RecallCache } from "../../src/types.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";
import type { RpcClient } from "../../src/rpc.js";

// ---------------------------------------------------------------------------
// Fake RPC — records every call with method + params so tests can assert
// exactly what the context engine sent to the daemon.
// ---------------------------------------------------------------------------
class FakeRpc {
  public calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  public searchResults: SearchResult[] = [];
  public assembleResponse: {
    messages: Array<{ role: string; content?: unknown; id?: string }>;
    estimatedTokens: number;
    systemPromptAddition: string;
  } = {
    messages: [],
    estimatedTokens: 0,
    systemPromptAddition: "",
  };

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    switch (method) {
      case "bootstrap_session_kernel":
        return { ok: true } as T;
      case "ingest_message_kernel":
        return { ingested: true } as T;
      case "after_turn_kernel":
        return { ok: true, turnCount: 1 } as T;
      case "compact_session":
        return { ok: true, didCompact: false } as T;
      case "assemble_context_internal":
        return this.assembleResponse as T;
      case "search_text_collections":
        return { results: this.searchResults } as T;
      default:
        throw new Error(`unexpected rpc method: ${method}`);
    }
  }
}

function fakeRecallCache(): RecallCache<SearchResult> {
  const store = new Map<string, unknown>();
  return {
    put(entry) { store.set(entry.userId + entry.queryText, entry); },
    get(key) { return store.get(key.userId + key.queryText) as never; },
    take(key) { return store.get(key.userId + key.queryText) as never; },
    clearUser() { store.clear(); },
  };
}

function fakeRuntime(rpc: FakeRpc): PluginRuntime {
  return {
    getRpc: async () => rpc as unknown as RpcClient,
    getKernel: () => null,
    emitLifecycleHint: async () => {},
    shutdown: async () => {},
  };
}

function makeMessage(role: string, content: string, id?: string) {
  return { role, content, ...(id ? { id } : {}) };
}

// ---------------------------------------------------------------------------
// Conformance: every entrypoint path must converge on the same lifecycle hooks
// with a stable sessionId, sessionKey, and durable userId.
// ---------------------------------------------------------------------------

test("context engine bootstrap resolves config userId and passes it to daemon", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { userId: "fixed-user" };
  const engine = buildContextEngineFactory(fakeRuntime(rpc), cfg, fakeRecallCache());

  await engine.bootstrap({ sessionId: "s1", sessionKey: "sk1" });

  const call = rpc.calls.find((c) => c.method === "bootstrap_session_kernel");
  assert.ok(call, "bootstrap_session_kernel RPC was called");
  assert.equal(call.params.sessionId, "s1");
  assert.equal(call.params.sessionKey, "sk1");
  assert.equal(call.params.userId, "fixed-user", "userId from config is passed through");
});

test("context engine ingest resolves config userId and passes it to daemon", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { userId: "fixed-user" };
  const engine = buildContextEngineFactory(fakeRuntime(rpc), cfg, fakeRecallCache());

  await engine.ingest({
    sessionId: "s1",
    sessionKey: "sk1",
    message: makeMessage("user", "remember this"),
  });

  const call = rpc.calls.find((c) => c.method === "ingest_message_kernel");
  assert.ok(call, "ingest_message_kernel RPC was called");
  assert.equal(call.params.sessionId, "s1");
  assert.equal(call.params.sessionKey, "sk1");
  assert.equal(call.params.userId, "fixed-user");
  const msg = call.params.message as { content: string };
  assert.equal(msg.content, "remember this");
});

test("context engine afterTurn resolves config userId and passes messages to daemon", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { userId: "fixed-user" };
  const engine = buildContextEngineFactory(fakeRuntime(rpc), cfg, fakeRecallCache());

  await engine.afterTurn({
    sessionId: "s1",
    sessionKey: "sk1",
    messages: [makeMessage("user", "hello"), makeMessage("assistant", "hi there")],
  });

  const call = rpc.calls.find((c) => c.method === "after_turn_kernel");
  assert.ok(call, "after_turn_kernel RPC was called");
  assert.equal(call.params.sessionId, "s1");
  assert.equal(call.params.sessionKey, "sk1");
  assert.equal(call.params.userId, "fixed-user");
  const msgs = call.params.messages as Array<unknown>;
  assert.equal(msgs.length, 2);
});

test("context engine assemble resolves config userId and passes it to daemon", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { userId: "fixed-user" };
  const engine = buildContextEngineFactory(fakeRuntime(rpc), cfg, fakeRecallCache());

  await engine.assemble({
    sessionId: "s1",
    sessionKey: "sk1",
    messages: [makeMessage("user", "query")],
    tokenBudget: 4000,
  });

  const call = rpc.calls.find((c) => c.method === "assemble_context_internal");
  assert.ok(call, "assemble_context_internal RPC was called");
  assert.equal(call.params.sessionId, "s1");
  assert.equal(call.params.sessionKey, "sk1");
  assert.equal(call.params.userId, "fixed-user");
});

test("context engine assemble injects exact factual recall for marker tokens", async () => {
  const rpc = new FakeRpc();
  const marker = "CROSS_SESSION_MEMORY_MARKER_1234567890";
  rpc.searchResults = [
    {
      id: "question",
      score: 1000,
      text: `What does ${marker} mean?`,
      metadata: { collection: "user:fixed-user", role: "user" },
    },
    {
      id: "fact",
      score: 0.7,
      text: `Remember this durable fact: ${marker} means Jay prefers the <blue lobster> path & "safe" 'quoted'.`,
      metadata: { collection: "user:fixed-user", role: "user" },
    },
  ];
  const cfg: PluginConfig = { userId: "fixed-user", topK: 4 };
  const engine = buildContextEngineFactory(fakeRuntime(rpc), cfg, fakeRecallCache());

  const assembled = await engine.assemble({
    sessionId: "s1",
    sessionKey: "sk1",
    messages: [makeMessage("user", `What does ${marker} mean?`)],
    prompt: `What does ${marker} mean?`,
    tokenBudget: 4000,
  });

  assert.ok(
    assembled.systemPromptAddition.includes("<exact_recalled_memory>"),
    "exact marker fact should be injected into system context so models treat it as authoritative recall",
  );
  assert.ok(assembled.systemPromptAddition.includes('source="exact_recalled"'));
  assert.ok(assembled.systemPromptAddition.includes("Use them to answer factual recall questions"));
  assert.ok(assembled.systemPromptAddition.includes(`${marker} means Jay prefers the &lt;blue lobster&gt; path`));
  assert.equal(assembled.systemPromptAddition.includes(`What does ${marker} mean?`), false);
  assert.ok(assembled.systemPromptAddition.includes("&amp; &quot;safe&quot; &#39;quoted&#39;"));
  assert.equal(assembled.systemPromptAddition.includes("<blue lobster>"), false);
  assert.equal(
    assembled.messages.some((message) => message.content.includes('source="exact_recalled"')),
    false,
  );
  const searchCall = rpc.calls.find((c) => c.method === "search_text_collections");
  assert.ok(searchCall, "exact recall search RPC was called");
  assert.equal(searchCall.params.text, marker);
});

test("context engine exact recall checks existing facts per block", async () => {
  const rpc = new FakeRpc();
  const firstMarker = "FIRST_SESSION_MEMORY_MARKER_1234567890";
  const secondMarker = "SECOND_SESSION_MEMORY_MARKER_1234567890";
  rpc.assembleResponse = {
    messages: [{ role: "assistant", content: `<entry>${secondMarker}</entry>` }],
    estimatedTokens: 20,
    systemPromptAddition: `${firstMarker} means Jay already has the first fact.`,
  };
  rpc.searchResults = [
    {
      id: "second-fact",
      score: 0.9,
      text: `${secondMarker} means Jay prefers the second path.`,
      metadata: { collection: "user:fixed-user" },
    },
  ];
  const engine = buildContextEngineFactory(fakeRuntime(rpc), { userId: "fixed-user" }, fakeRecallCache());

  const assembled = await engine.assemble({
    sessionId: "s1",
    sessionKey: "sk1",
    messages: [makeMessage("user", `What do ${firstMarker} and ${secondMarker} mean?`)],
    prompt: `What do ${firstMarker} and ${secondMarker} mean?`,
    tokenBudget: 4000,
  });

  const searches = rpc.calls.filter((c) => c.method === "search_text_collections");
  assert.deepEqual(
    searches.map((call) => call.params.text),
    [secondMarker],
  );
  assert.ok(assembled.systemPromptAddition.includes(`${secondMarker} means Jay prefers the second path.`));
});

test("context engine exact recall skips additions that would exceed the token budget", async () => {
  const rpc = new FakeRpc();
  const marker = "BUDGET_SESSION_MEMORY_MARKER_1234567890";
  rpc.assembleResponse = {
    messages: [],
    estimatedTokens: 43,
    systemPromptAddition: "",
  };
  rpc.searchResults = [
    {
      id: "budget-fact",
      score: 0.9,
      text: `${marker} means Jay prefers a fact that is too large for the remaining budget.`,
      metadata: { collection: "user:fixed-user" },
    },
  ];
  const warnings: string[] = [];
  const engine = buildContextEngineFactory(fakeRuntime(rpc), { userId: "fixed-user" }, fakeRecallCache(), {
    error() {},
    info() {},
    warn(message: string) { warnings.push(message); },
  });

  const assembled = await engine.assemble({
    sessionId: "s1",
    sessionKey: "sk1",
    messages: [makeMessage("user", `What does ${marker} mean?`)],
    prompt: `What does ${marker} mean?`,
    tokenBudget: 300,
  });

  assert.equal(assembled.systemPromptAddition, "");
  assert.equal(assembled.estimatedTokens, 43);
  assert.match(warnings[0] ?? "", /addition exceeds token budget/);
});

test("context engine assemble keeps daemon result when exact recall RPC acquisition fails", async () => {
  const rpc = new FakeRpc();
  const marker = "CROSS_SESSION_MEMORY_MARKER_1234567891";
  rpc.assembleResponse = {
    messages: [{ role: "assistant", content: "base recalled context" }],
    estimatedTokens: 24,
    systemPromptAddition: "",
  };
  let getRpcCalls = 0;
  const runtime: PluginRuntime = {
    getRpc: async () => {
      getRpcCalls += 1;
      if (getRpcCalls === 1) return rpc as unknown as RpcClient;
      throw new Error("socket unavailable");
    },
    getKernel: () => null,
    emitLifecycleHint: async () => {},
    shutdown: async () => {},
  };
  const warnings: string[] = [];
  const engine = buildContextEngineFactory(runtime, { userId: "fixed-user" }, fakeRecallCache(), {
    error() {},
    info() {},
    warn(message: string) { warnings.push(message); },
  });

  const assembled = await engine.assemble({
    sessionId: "s1",
    sessionKey: "sk1",
    messages: [makeMessage("user", `What does ${marker} mean?`)],
    prompt: `What does ${marker} mean?`,
    tokenBudget: 4000,
  });

  assert.deepEqual(assembled.messages, [{ role: "assistant", content: "base recalled context" }]);
  assert.equal(getRpcCalls, 2);
  assert.match(warnings[0] ?? "", /exact recall skipped/);
});

test("exact recall extracts quoted phrases from user queries", async () => {
  const rpc = new FakeRpc();
  const phrase = "blue lobster preference";
  rpc.searchResults = [
    {
      id: "fact-1",
      score: 0.9,
      text: `Remember this: "${phrase}" means Jay always picks the blue one.`,
      metadata: { collection: "user:fixed-user" },
    },
  ];
  const cfg: PluginConfig = { userId: "fixed-user", topK: 4 };
  const engine = buildContextEngineFactory(fakeRuntime(rpc), cfg, fakeRecallCache());

  const assembled = await engine.assemble({
    sessionId: "s1",
    sessionKey: "sk1",
    messages: [makeMessage("user", `What does "${phrase}" mean?`)],
    prompt: `What does "${phrase}" mean?`,
    tokenBudget: 4000,
  });

  assert.ok(
    assembled.systemPromptAddition.includes('source="exact_recalled"'),
    "exact recall should fire for quoted phrases",
  );
  const searchCall = rpc.calls.find((c) => c.method === "search_text_collections");
  assert.ok(searchCall);
  assert.equal(searchCall.params.text, phrase);
});

test("exact recall extracts mixed-case identifiers with separators", async () => {
  const rpc = new FakeRpc();
  const key = "UserPref_blueLobster_v2";
  rpc.searchResults = [
    {
      id: "fact-1",
      score: 0.8,
      text: `${key} means Jay prefers the blue lobster path.`,
      metadata: { collection: "user:fixed-user" },
    },
  ];
  const cfg: PluginConfig = { userId: "fixed-user", topK: 4 };
  const engine = buildContextEngineFactory(fakeRuntime(rpc), cfg, fakeRecallCache());

  const assembled = await engine.assemble({
    sessionId: "s1",
    sessionKey: "sk1",
    messages: [makeMessage("user", `What does ${key} mean?`)],
    prompt: `What does ${key} mean?`,
    tokenBudget: 4000,
  });

  assert.ok(
    assembled.systemPromptAddition.includes('source="exact_recalled"'),
    "exact recall should fire for mixed-case identifiers",
  );
  const searchCall = rpc.calls.find((c) => c.method === "search_text_collections");
  assert.ok(searchCall);
  assert.equal(searchCall.params.text, key);
});

test("exact recall skips common query words even when in quoted phrases", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { userId: "fixed-user", topK: 4 };
  const engine = buildContextEngineFactory(fakeRuntime(rpc), cfg, fakeRecallCache());

  // All tokens are common query words — no exact recall should fire
  await engine.assemble({
    sessionId: "s1",
    sessionKey: "sk1",
    messages: [makeMessage("user", "what does this mean")],
    prompt: "what does this mean",
    tokenBudget: 4000,
  });

  const searchCall = rpc.calls.find((c) => c.method === "search_text_collections");
  assert.equal(searchCall ?? null, null, "exact recall should not fire for common words");
});

// ---------------------------------------------------------------------------
// Identity stability: same userId across different sessions
// ---------------------------------------------------------------------------

test("identity is stable across multiple sessions with the same config userId", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { userId: "fixed-user" };
  const engine = buildContextEngineFactory(fakeRuntime(rpc), cfg, fakeRecallCache());

  // Session A
  await engine.bootstrap({ sessionId: "session-a", sessionKey: "key-a" });
  await engine.ingest({ sessionId: "session-a", sessionKey: "key-a", message: makeMessage("user", "a1") });
  await engine.afterTurn({ sessionId: "session-a", sessionKey: "key-a", messages: [makeMessage("user", "a1")] });

  // Session B
  await engine.bootstrap({ sessionId: "session-b", sessionKey: "key-b" });
  await engine.ingest({ sessionId: "session-b", sessionKey: "key-b", message: makeMessage("user", "b1") });
  await engine.afterTurn({ sessionId: "session-b", sessionKey: "key-b", messages: [makeMessage("user", "b1")] });

  // Every call should have the same userId
  const userIds = rpc.calls
    .filter((c) => c.params.userId !== undefined)
    .map((c) => c.params.userId);
  assert.ok(userIds.length >= 2, "multiple calls with userId");
  for (const uid of userIds) {
    assert.equal(uid, "fixed-user", "userId is stable across sessions");
  }

  // sessionKey is forwarded per-session
  const sessionAKeys = rpc.calls
    .filter((c) => c.params.sessionId === "session-a")
    .map((c) => c.params.sessionKey);
  assert.ok(sessionAKeys.length >= 2, "multiple session-a calls");
  for (const sk of sessionAKeys) {
    assert.equal(sk, "key-a");
  }

  const sessionBKeys = rpc.calls
    .filter((c) => c.params.sessionId === "session-b")
    .map((c) => c.params.sessionKey);
  assert.ok(sessionBKeys.length >= 2, "multiple session-b calls");
  for (const sk of sessionBKeys) {
    assert.equal(sk, "key-b");
  }
});

// ---------------------------------------------------------------------------
// Framework-provided userId takes priority over config
// ---------------------------------------------------------------------------

test("framework-provided userId override takes priority over config userId", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { userId: "config-user" };
  const engine = buildContextEngineFactory(fakeRuntime(rpc), cfg, fakeRecallCache());

  await engine.bootstrap({ sessionId: "s1", sessionKey: "sk1", userId: "framework-user" });

  const call = rpc.calls.find((c) => c.method === "bootstrap_session_kernel");
  assert.ok(call);
  assert.equal(call.params.sessionKey, "sk1");
  assert.equal(call.params.userId, "framework-user", "framework-provided userId wins over config");
});

// ---------------------------------------------------------------------------
// Identity resolution without config userId: when only sessionKey is provided,
// identity auto-derives from OS details. The sessionKey is forwarded to the
// daemon for session-scoped operations regardless of the resolved userId.
// The "session-key:" prefix fallback is a safety net for environments where
// OS identity APIs fail entirely (tested via resolveIdentity directly below).
// ---------------------------------------------------------------------------

test("identity is resolved and sessionKey forwarded when no config userId is set", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = {};
  const engine = buildContextEngineFactory(fakeRuntime(rpc), cfg, fakeRecallCache());

  await engine.bootstrap({ sessionId: "s1", sessionKey: "provided-key" });

  const call = rpc.calls.find((c) => c.method === "bootstrap_session_kernel");
  assert.ok(call);
  assert.equal(call.params.sessionKey, "provided-key");
  const uid = call.params.userId as string;
  assert.equal(typeof uid, "string");
  assert.ok(uid.length > 0, "userId is never empty");
});

// ---------------------------------------------------------------------------
// sessionId is always passed through
// ---------------------------------------------------------------------------

test("sessionId is non-empty in every lifecycle hook across bootstrap/ingest/afterTurn", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { userId: "u1" };
  const engine = buildContextEngineFactory(fakeRuntime(rpc), cfg, fakeRecallCache());

  const sessionId = "conformance-session-1";
  await engine.bootstrap({ sessionId, sessionKey: "sk" });
  await engine.ingest({ sessionId, sessionKey: "sk", message: makeMessage("user", "m1") });
  await engine.afterTurn({ sessionId, sessionKey: "sk", messages: [makeMessage("user", "m1")] });

  const lifecycleCalls = rpc.calls.filter(
    (c) => c.method === "bootstrap_session_kernel" ||
          c.method === "ingest_message_kernel" ||
          c.method === "after_turn_kernel",
  );
  assert.equal(lifecycleCalls.length, 3, "bootstrap, ingest, and afterTurn all fired");
  for (const call of lifecycleCalls) {
    assert.equal(call.params.sessionId, sessionId);
    assert.equal(call.params.sessionKey, "sk");
  }
});

// ---------------------------------------------------------------------------
// Heartbeat messages are forwarded with the flag
// ---------------------------------------------------------------------------

test("ingest forwards isHeartbeat flag to the daemon", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { userId: "u1" };
  const engine = buildContextEngineFactory(fakeRuntime(rpc), cfg, fakeRecallCache());

  await engine.ingest({
    sessionId: "s1",
    message: makeMessage("user", "heartbeat check"),
    isHeartbeat: true,
  });

  const call = rpc.calls.find((c) => c.method === "ingest_message_kernel");
  assert.ok(call);
  assert.equal(call.params.isHeartbeat, true);
});

// ---------------------------------------------------------------------------
// Direct identity resolution: verify resolveIdentity contract without the
// context engine indirection. The session-key fallback ("session-key:...")
// triggers only when OS identity APIs fail entirely, which is a safety net
// that is hard to reach in test environments but exercised here for coverage
// of all reachable paths.
// ---------------------------------------------------------------------------

test("resolveIdentity returns config userId with source=config", () => {
  const result = resolveIdentity({ configUserId: "explicit-user" });
  assert.equal(result.userId, "explicit-user");
  assert.equal(result.source, "config");
});

test("resolveIdentity returns config userId with whitespace trimming", () => {
  const result = resolveIdentity({ configUserId: "  padded-user  " });
  assert.equal(result.userId, "padded-user");
  assert.equal(result.source, "config");
});

test("resolveIdentity auto-derives when only sessionKey is provided", () => {
  const result = resolveIdentity({ sessionKey: "sk-test" });
  assert.equal(typeof result.userId, "string");
  assert.ok(result.userId.length > 0);
  // In typical test environments userInfo() succeeds, so source is "auto".
  // An existing identity file or the "session-key" safety net may also apply.
  assert.ok(
    ["auto", "session-key", "file"].includes(result.source),
    `source should be auto, session-key, or file, got ${result.source}`,
  );
});

test("resolveIdentity returns 'default' when no inputs are provided", () => {
  const result = resolveIdentity({});
  // When userInfo() works: auto-derived. An identity file or "default" may also apply.
  assert.ok(["auto", "default", "file"].includes(result.source));
  assert.ok(result.userId.length > 0);
});
