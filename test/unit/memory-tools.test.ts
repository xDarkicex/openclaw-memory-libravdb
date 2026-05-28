import test from "node:test";
import assert from "node:assert/strict";

import { createLibraVdbMemoryTools } from "../../src/memory-tools.js";
import type { PluginConfig } from "../../src/types.js";

const silentLogger = {
  error(_message: string) {},
  warn(_message: string) {},
  info(_message: string) {},
};

class FakeRpc {
  public calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  async status() {
    this.calls.push({ method: "status", params: {} });
    return {
      ok: true,
      message: "ok",
      turnCount: 2,
      memoryCount: 1,
      embeddingProfile: "nomic-embed-text-v1.5",
    };
  }

  async searchTextCollections(params: Record<string, unknown>) {
    this.calls.push({ method: "searchTextCollections", params });
    const collections = params.collections as string[] | undefined;
    const encoder = new TextEncoder();
    return {
      results: [
        {
          id: "m1",
          score: 0.92,
          text: "first interaction was in Discord",
          metadataJson: encoder.encode(JSON.stringify({ collection: collections?.[0] ?? "user:u1" })),
        },
        {
          id: "m2",
          score: 0.82,
          text: "durable project preference",
          metadataJson: encoder.encode(JSON.stringify({ collection: collections?.[1] ?? "user:u1" })),
        },
      ],
    };
  }

  async searchText(params: Record<string, unknown>) {
    this.calls.push({ method: "searchText", params });
    const encoder = new TextEncoder();
    return {
      results: [
        {
          id: "m1",
          score: 0.92,
          text: "single collection result",
          metadataJson: encoder.encode(JSON.stringify({ collection: String(params.collection) })),
        },
      ],
    };
  }
}

class CorpusPriorityRpc extends FakeRpc {
  override async searchTextCollections(params: Record<string, unknown>) {
    this.calls.push({ method: "searchTextCollections", params });
    const encoder = new TextEncoder();
    return {
      results: [
        {
          id: "durable-top",
          score: 0.99,
          text: "durable memory outranks the session hit",
          metadataJson: encoder.encode(JSON.stringify({ collection: "user:u1" })),
        },
      ],
    };
  }

  override async searchText(params: Record<string, unknown>) {
    this.calls.push({ method: "searchText", params });
    const encoder = new TextEncoder();
    return {
      results: [
        {
          id: "session-hit",
          score: 0.72,
          text: "session hit below durable memory",
          metadataJson: encoder.encode(JSON.stringify({ collection: String(params.collection) })),
        },
      ],
    };
  }
}

test("LibraVDB memory tools expose memory_search and memory_get through the runtime bridge", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { userId: "u1", topK: 4 };
  const tools = createLibraVdbMemoryTools(async () => rpc as never, cfg, silentLogger);
  const ctx = { agentId: "spartacus", sessionId: "discord-session", sessionKey: "discord-key" };
  const searchTool = tools.createSearchTool(ctx);
  const getTool = tools.createGetTool(ctx);

  assert.equal(searchTool.name, "memory_search");
  assert.equal(getTool.name, "memory_get");

  const search = await searchTool.execute("call-1", {
    query: "earliest memory",
    maxResults: 2,
  });
  const searchDetails = search.details as {
    results: Array<{ path: string; snippet: string; source: string }>;
    provider?: string;
    model?: string;
    backend?: string;
  };

  assert.equal(searchDetails.results.length, 2);
  assert.equal(searchDetails.results[0]?.snippet, "first interaction was in Discord");
  assert.equal(searchDetails.results[0]?.source, "sessions");
  assert.equal(searchDetails.provider, "libravdb");
  assert.equal(searchDetails.model, "nomic-embed-text-v1.5");
  assert.equal(searchDetails.backend, "builtin");
  assert.equal(rpc.calls[0]?.method, "status");
  assert.equal(rpc.calls[1]?.method, "searchTextCollections");
  assert.deepEqual(rpc.calls[1]?.params.collections, [
    "session:discord-session",
    "user:u1",
    "global",
  ]);

  const get = await getTool.execute("call-2", {
    path: searchDetails.results[0]?.path,
    from: 1,
    lines: 1,
  });
  assert.deepEqual(get.details, {
    path: searchDetails.results[0]?.path,
    text: "first interaction was in Discord",
  });
});

test("LibraVDB memory_search supports sessions corpus filtering without memory-core", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { userId: "u1" };
  const tools = createLibraVdbMemoryTools(async () => rpc as never, cfg, silentLogger);
  const searchTool = tools.createSearchTool({
    agentId: "spartacus",
    sessionId: "discord-session",
    sessionKey: "discord-key",
  });

  const search = await searchTool.execute("call-1", {
    query: "discord",
    corpus: "sessions",
  });
  const details = search.details as { results: Array<{ source: string; snippet: string }> };

  assert.equal(rpc.calls[1]?.method, "searchText");
  assert.equal(rpc.calls[1]?.params.collection, "session:discord-session");
  assert.deepEqual(
    details.results.map((result) => result.source),
    ["sessions"],
  );
  assert.equal(details.results[0]?.snippet, "single collection result");
});

test("LibraVDB memory_search constrains sessions corpus before top-k ranking", async () => {
  const rpc = new CorpusPriorityRpc();
  const cfg: PluginConfig = { userId: "u1" };
  const tools = createLibraVdbMemoryTools(async () => rpc as never, cfg, silentLogger);
  const searchTool = tools.createSearchTool({
    agentId: "spartacus",
    sessionId: "discord-session",
    sessionKey: "discord-key",
  });

  const search = await searchTool.execute("call-1", {
    query: "needle",
    corpus: "sessions",
    maxResults: 1,
  });
  const details = search.details as { results: Array<{ source: string; snippet: string }> };

  assert.equal(rpc.calls[1]?.method, "searchText");
  assert.equal(rpc.calls[1]?.params.collection, "session:discord-session");
  assert.equal(
    rpc.calls.some((call) => call.method === "searchTextCollections"),
    false,
    "sessions corpus must not search mixed durable collections before filtering",
  );
  assert.deepEqual(details.results, [
    {
      path: "session%3Adiscord-session::session-hit",
      startLine: 1,
      endLine: 1,
      score: 0.72,
      snippet: "session hit below durable memory",
      source: "sessions",
      citation: "session:discord-session:session-hit",
    },
  ]);
});

test("LibraVDB memory_search constrains memory corpus before top-k ranking", async () => {
  const rpc = new FakeRpc();
  const cfg: PluginConfig = { userId: "u1" };
  const tools = createLibraVdbMemoryTools(async () => rpc as never, cfg, silentLogger);
  const searchTool = tools.createSearchTool({
    agentId: "spartacus",
    sessionId: "discord-session",
    sessionKey: "discord-key",
  });

  const search = await searchTool.execute("call-1", {
    query: "durable",
    corpus: "memory",
    maxResults: 1,
  });
  const details = search.details as { results: Array<{ source: string; snippet: string }> };

  assert.equal(rpc.calls[1]?.method, "searchTextCollections");
  assert.deepEqual(rpc.calls[1]?.params.collections, ["user:u1", "global"]);
  assert.deepEqual(
    details.results.map((result) => result.source),
    ["memory", "memory"],
  );
});

test("LibraVDB memory_get reports unknown paths as disabled instead of reading arbitrary files", async () => {
  const rpc = new FakeRpc();
  const tools = createLibraVdbMemoryTools(async () => rpc as never, { userId: "u1" }, silentLogger);
  const getTool = tools.createGetTool({ agentId: "spartacus" });

  const get = await getTool.execute("call-1", {
    path: "user%3Au1::crafted",
  });

  assert.deepEqual(get.details, {
    path: "user%3Au1::crafted",
    text: "",
    disabled: true,
    error: "LibraVDB memory path was not returned by this search manager",
  });
});
