import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildContextEngineFactory } from "../../src/context-engine.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";
import type { LibravDBClient } from "../../src/libravdb-client.js";

test("overlapping commits use the runtime write tenant and retain both checkpoints", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-concurrent-destinations-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  const calls: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  function runtime(tenant: string): PluginRuntime {
    return {
      resolveWriteTenantKey: () => tenant,
      getClient: async () => ({
        async afterTurnKernel() {
          calls.push(tenant);
          if (tenant === "a") { started(); await held; }
          return {};
        },
        async searchTextCollections() { return { results: [] }; },
      }) as unknown as LibravDBClient,
      async shutdown() {}, onShutdown() {}, async emitLifecycleHint() {},
    };
  }
  const cfg = { userId: "tester", tenantId: "default", grpcEndpoint: "tcp:127.0.0.1:10001" };
  const logger = { info() {}, warn() {}, error() {} };
  const first = buildContextEngineFactory(runtime("a"), cfg, logger);
  const second = buildContextEngineFactory(runtime("b"), cfg, logger);
  const sessionId = randomUUID();
  const args = { sessionId, advancementKey: sessionId, messages: [{ role: "user", content: "original", id: "user-1" }] };
  try {
    const firstCommit = first.commitTurn(args);
    await firstStarted;
    const secondCommit = second.commitTurn(args);
    release();
    assert.deepEqual(await Promise.all([firstCommit, secondCommit]), [{ status: "committed" }, { status: "committed" }]);
    assert.deepEqual(calls, ["a", "b"]);
    // A different key bypasses the in-memory memo and exercises both durable checkpoints.
    await first.commitTurn({ ...args, advancementKey: `${sessionId}-again` });
    await second.commitTurn({ ...args, advancementKey: `${sessionId}-again` });
    assert.deepEqual(calls, ["a", "b"]);
  } finally {
    release();
    await first.dispose(); await second.dispose();
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const changed of ["endpoint", "tenant"] as const) {
  for (const repeatKey of [true, false]) {
    test(`session checkpoint is isolated after changing ${changed} (same advancement key: ${repeatKey})`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-destination-"));
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = root;
      const calls: Array<{ destination: string; params: Record<string, unknown> }> = [];
      function runtime(destination: string): PluginRuntime {
        const client = {
          async afterTurnKernel(params: Record<string, unknown>) { calls.push({ destination, params }); return {}; },
          async searchTextCollections() { return { results: [] }; },
        } as unknown as LibravDBClient;
        return { getClient: async () => client, async shutdown() {}, onShutdown() {}, async emitLifecycleHint() {} };
      }
      const cfgA = { userId: "tester", tenantId: "tenant-a", grpcEndpoint: "tcp:127.0.0.1:10001" };
      const cfgB = { ...cfgA, ...(changed === "endpoint" ? { grpcEndpoint: "tcp:127.0.0.1:10002" } : { tenantId: "tenant-b" }) };
      const engineA = buildContextEngineFactory(runtime("a"), cfgA, { info() {}, warn() {}, error() {} });
      const engineB = buildContextEngineFactory(runtime("b"), cfgB, { info() {}, warn() {}, error() {} });
      const sessionId = randomUUID();
      const args = { sessionId, advancementKey: `first-${sessionId}`, messages: [
        { role: "user", content: "Remember the Cedar project", id: "source-user" },
        { role: "assistant", content: "Cedar is scheduled for Friday", id: "source-assistant" },
      ] };
      try {
        assert.equal((await engineA.commitTurn(args)).status, "committed");
        assert.equal(calls.length, 1);
        assert.equal((await engineA.commitTurn(args)).status, "duplicate");
        await engineB.commitTurn({ ...args, advancementKey: repeatKey ? args.advancementKey : `new-destination-${sessionId}` });
        assert.equal(calls.filter(call => call.destination === "b").length, 1,
          "the new destination never received these messages and must not inherit another destination's acknowledgment");
      } finally {
        await engineA.dispose(); await engineB.dispose();
        if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previousStateDir;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
