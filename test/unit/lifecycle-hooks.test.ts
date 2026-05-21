import test from "node:test";
import assert from "node:assert/strict";

import { createBeforeResetHook, createSessionEndHook } from "../../src/lifecycle-hooks.js";
import type { LifecycleHint, PluginRuntime } from "../../src/plugin-runtime.js";

function createRuntimeRecorder() {
  const hints: LifecycleHint[] = [];
  const runtime: PluginRuntime = {
    async getClient() {
      throw new Error("not used in lifecycle hook tests");
    },
    async emitLifecycleHint(hint: LifecycleHint) {
      hints.push(hint);
    },
    onShutdown() {},
    async shutdown() {},
  };
  return { runtime, hints };
}

test("before_reset hook forwards advisory reset context to the runtime", async () => {
  const { runtime, hints } = createRuntimeRecorder();
  const hook = createBeforeResetHook(runtime);

  await hook(
    {
      reason: "reset",
      sessionFile: "/tmp/session.jsonl",
      messages: [{}, {}, {}],
    },
    {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "session-key-1",
      workspaceDir: "/repo",
    },
  );

  assert.deepEqual(hints, [
    {
      hook: "before_reset",
      reason: "reset",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      sessionKey: "session-key-1",
      agentId: "agent-1",
      workspaceDir: "/repo",
      messageCount: 3,
    },
  ]);
});

test("session_end hook forwards advisory end metadata to the runtime", async () => {
  const { runtime, hints } = createRuntimeRecorder();
  const infos: string[] = [];
  const hook = createSessionEndHook(runtime, {
    error() {},
    info(message: string) {
      infos.push(message);
    },
    warn() {},
  });

  await hook(
    {
      sessionId: "session-2",
      sessionKey: "session-key-2",
      messageCount: 9,
      durationMs: 4200,
      reason: "compaction",
      sessionFile: "/tmp/archived.jsonl",
      transcriptArchived: true,
      nextSessionId: "session-3",
      nextSessionKey: "session-key-3",
    },
    {
      agentId: "agent-2",
      workspaceDir: "/repo-two",
    },
  );

  assert.deepEqual(hints, [
    {
      hook: "session_end",
      reason: "compaction",
      sessionFile: "/tmp/archived.jsonl",
      sessionId: "session-2",
      sessionKey: "session-key-2",
      agentId: "agent-2",
      workspaceDir: "/repo-two",
      messageCount: 9,
      durationMs: 4200,
      transcriptArchived: true,
      nextSessionId: "session-3",
      nextSessionKey: "session-key-3",
    },
  ]);
  assert.match(infos[0] ?? "", /LibraVDB session_end/);
  assert.match(infos[0] ?? "", /sessionId=session-2/);
  assert.match(infos[0] ?? "", /durationMs=4200/);
});
