import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildContextEngineFactory } from "../../src/context-engine.js";
import type { PluginRuntime } from "../../src/plugin-runtime.js";
import type { LibravDBClient } from "../../src/libravdb-client.js";

for (const scenario of ["other-session-write", "existing-reader"] as const) {
  test(`continuity survives ${scenario} across engine instances`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-persistence-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    const client = {
      async afterTurnKernel() { return {}; },
      async searchTextCollections() { return { results: [] }; },
      async assembleContextInternal() { return { messages: [], estimatedTokens: 0, systemPromptAddition: "" }; },
    } as unknown as LibravDBClient;
    const runtime: PluginRuntime = { getClient: async () => client, onShutdown() {}, async shutdown() {}, async emitLifecycleHint() {} };
    const cfg = { userId: "tester", beforeTurnEnabled: false };
    const logger = { info() {}, warn() {}, error() {} };
    const engines: ReturnType<typeof buildContextEngineFactory>[] = [];
    function engine() { const next = buildContextEngineFactory(runtime, cfg, logger); engines.push(next); return next; }
    async function commit(target: ReturnType<typeof engine>, sessionKey: string, fact: string) {
      const sessionId = randomUUID();
      await target.commitTurn({ sessionId, sessionKey, advancementKey: sessionId, messages: [
        { role: "user", content: `Remember ${fact}`, id: randomUUID() },
        { role: "assistant", content: `Confirmed ${fact}`, id: randomUUID() },
      ] });
    }
    async function recall(target: ReturnType<typeof engine>, sessionKey: string) {
      return target.assemble({ sessionId: randomUUID(), sessionKey, tokenBudget: 4000,
        messages: [{ role: "user", content: "What did we discuss?", id: randomUUID() }] });
    }
    try {
      const first = engine();
      const second = engine();
      if (scenario === "other-session-write") {
        await commit(first, "agent:a:main", "ALPHA_LEDGER");
        await commit(second, "agent:b:main", "BETA_LEDGER");
        const reopened = engine();
        assert.match((await recall(reopened, "agent:a:main")).systemPromptAddition, /ALPHA_LEDGER/);
        assert.match((await recall(reopened, "agent:b:main")).systemPromptAddition, /BETA_LEDGER/);
      } else {
        await commit(first, "agent:a:main", "NEWEST_LEDGER");
        assert.match((await recall(second, "agent:a:main")).systemPromptAddition, /NEWEST_LEDGER/,
          "an engine created before the write must read the latest continuity");
      }
    } finally {
      for (const active of engines) await active.dispose();
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previousStateDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
