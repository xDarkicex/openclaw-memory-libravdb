import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { register } from "../../src/index.js";
import { setRule } from "../../src/rules.js";

type HostRunner = NonNullable<ReturnType<typeof getGlobalHookRunner>>;

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rule-delivery-"));
  const hooks = new Map<string, (...args: any[]) => any>();
  register({
    registrationMode: "full", cacheDir: root,
    config: { plugins: { slots: { memory: "libravdb-memory", contextEngine: "libravdb-memory" } } },
    pluginConfig: { userId: "tester", maxRules: 20 },
    logger: { info() {}, warn() {}, error() {} },
    registerMemoryCapability() {}, registerContextEngine() {}, registerTool() {}, registerCli() {},
    on(hookName: string, handler: (...args: any[]) => any) {
      hooks.set(hookName, handler);
    },
  } as any);
  setRule("Do not reveal the confidential project code", ["orchid-731"], 10);
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
  return {
    // Use the installed host's public event/result types, without starting its
    // unrelated runtime databases merely to invoke the registered callbacks.
    runMessageSending: hooks.get("message_sending") as HostRunner["runMessageSending"] | undefined,
    runBeforeAgentReply: hooks.get("before_agent_reply") as HostRunner["runBeforeAgentReply"] | undefined,
  };
}

test("rule keywords replace outgoing message text using the host delivery contract", async t => {
  const runner = fixture(t);
  const event = { to: "test-channel", content: "The private code is ORCHID-731." };
  const result = await runner.runMessageSending?.(event, { channelId: "discord" });
  assert.equal(result?.content, "I cannot answer that.");
  assert.equal(event.content, "The private code is ORCHID-731.", "the hook result replaces delivery without mutating the event");
});

test("mentioning a rule keyword in an inbound prompt does not claim the agent turn", async t => {
  const runner = fixture(t);
  const result = await runner.runBeforeAgentReply?.({ cleanedBody: "Please keep orchid-731 private." }, { trigger: "user" });
  assert.equal(result, undefined, "rule enforcement belongs to outgoing delivery, not incoming requests");
});

test("clean outgoing text passes through unchanged", async t => {
  const runner = fixture(t);
  assert.equal(await runner.runMessageSending?.({ to: "test-channel", content: "The project is on schedule." }, { channelId: "discord" }), undefined);
  assert.equal(await runner.runMessageSending?.({ to: "test-channel", content: "" }, { channelId: "discord" }), undefined);
});
