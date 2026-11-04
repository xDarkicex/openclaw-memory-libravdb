import test from "node:test";
import assert from "node:assert/strict";
import type { OpenClawPluginApi as InstalledPluginApi } from "../../node_modules/openclaw/dist/plugin-sdk/plugin-entry.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { SummarizeMessagesRequest, SummarizeMessagesResponse } from "@xdarkicex/libravdb-contracts";
import { LibravDBClient } from "../../src/libravdb-client.js";
import { register, MEMORY_ID } from "../../src/index.js";

type Provider = Parameters<InstalledPluginApi["registerCompactionProvider"]>[0];

test("compaction provider sends the previous summary through subsequent summarization RPCs", async t => {
  let provider!: Provider;
  let shutdown!: () => Promise<void>;
  const requests: SummarizeMessagesRequest[] = [];
  t.mock.method(LibravDBClient.prototype, "bootstrapHandshake", async () => {});
  t.mock.method(LibravDBClient.prototype, "summarizeMessages", async (request: ConstructorParameters<typeof SummarizeMessagesRequest>[0]) => {
    const wire = SummarizeMessagesRequest.fromBinary(new SummarizeMessagesRequest(request).toBinary());
    requests.push(wire);
    return new SummarizeMessagesResponse({ summaryText: wire.messages.map(message => message.content).join("\n") });
  });
  t.mock.method(LibravDBClient.prototype, "flush", async () => ({ ok: true }));
  t.mock.method(LibravDBClient.prototype, "close", () => {});
  register({
    registrationMode: "full", pluginConfig: { userId: "tester" },
    config: { plugins: { slots: { memory: MEMORY_ID, contextEngine: MEMORY_ID } } },
    logger: { info() {}, warn() {}, error() {} },
    registerTool() {}, registerContextEngine() {}, registerMemoryCapability() {}, registerService() {},
    registerCompactionProvider(value: Provider) { provider = value; },
    on(event: string, handler: () => Promise<void>) { if (event === "gateway_stop") shutdown = handler; },
  } as unknown as OpenClawPluginApi);
  try {
    const firstMessages = [{ role: "user", content: "Older decision: project code Cedar-42." }];
    const firstSummary = await provider.summarize({ messages: firstMessages });
    assert.equal(requests[0]?.messages.length, 1, "first compaction needs no synthetic summary message");
    const nextMessages = [{ role: "user", content: "New decision: release is Friday." }];
    const secondSummary = await provider.summarize({ messages: nextMessages, previousSummary: firstSummary });
    assert.match(requests[1]!.messages.map(message => message.content).join("\n"), /Cedar-42/,
      "the daemon cannot retain prior decisions if its request omits the host's previous summary");
    assert.match(secondSummary, /Cedar-42/);
    assert.match(secondSummary, /release is Friday/);
    assert.deepEqual(nextMessages, [{ role: "user", content: "New decision: release is Friday." }]);
    const summaryOnly = await provider.summarize({ messages: [], previousSummary: secondSummary });
    assert.match(summaryOnly, /Cedar-42/);
    assert.match(summaryOnly, /release is Friday/);
    await provider.summarize({ messages: nextMessages, previousSummary: "  \n  " });
    assert.equal(requests[3]?.messages.length, 1, "blank summaries must not add source messages");
  } finally { await shutdown(); }
});
