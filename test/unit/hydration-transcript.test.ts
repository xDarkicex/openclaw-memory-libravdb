import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyHydrationPrompt, hydrationTurnKey, TranscriptHydration, type TranscriptReader } from "../../src/hydration-transcript.js";
import type { LibravDBClient } from "../../src/libravdb-client.js";

const scope = { tenant: "fixture", session: "session", audience: "room" };
function fixture() {
  const hooks: { search?: () => Promise<void>; unavailable?: boolean } = {};
  const rows = new Map<string, any>();
  const entries: any[] = [
    { entryId: "u", message: { role: "user", content: "Investigate the connection failure" } },
    { entryId: "call", message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "lookup" }] } },
    { entryId: "result", message: { role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "Certificate expired yesterday; renewed today." }] } },
    { entryId: "final", createdAt: "2026-01-01T00:00:00Z", message: { role: "assistant", stopReason: "stop", content: "Renewing TLS certificates restored the connection." } },
    { entryId: "next", message: { role: "user", content: "hello" } },
  ];
  let reset = false;
  const read: TranscriptReader = async ({ cursor, maxBytes, maxMessages }) => {
    assert.ok(maxBytes <= 1048576); assert.equal(maxMessages, 1);
    if (hooks.unavailable) return { kind: "unavailable" };
    if (reset) return { kind: "reset", cursor: "0" };
    const i = Number(cursor ?? 0);
    return { kind: "page", cursor: String(i + 1), entries: entries.slice(i, i + 1), hasMore: i + 1 < entries.length };
  };
  const client = {
    async ensureCollections() { return { ok: true }; },
    async insertText(r: any) {
      const metadata = JSON.parse(Buffer.from(r.metadataJson).toString());
      const { tenant, session, audience } = metadata.frame.scope;
      metadata.frame.scope = { audience, session, tenant };
      rows.set(r.id, { ...r, metadataJson: Buffer.from(JSON.stringify(metadata)) }); return { ok: true };
    },
    async searchText(r: any) {
      await hooks.search?.();
      const relevant = /connection|tls|secure/i.test(r.text);
      return { results: [...rows.values()].map(row => ({ ...row, score: relevant ? 0.85 : 0.4 })) };
    },
    async listByMeta(r: any) { return { results: [...rows.values()].filter(row => row.id === r.value) }; },
  } as unknown as LibravDBClient;
  const make = (s = scope, reader = read) => new TranscriptHydration(s, client, reader, text => text);
  return { rows, entries, make, hooks, read, invalidate() { reset = true; }, restore() { reset = false; } };
}

test("transcript hydration survives replacement and returns original evidence only on related queries", async () => {
  const f = fixture(); const first = f.make(); await first.refresh(); await first.close();
  assert.equal(f.rows.size, 1);
  assert.ok(![...f.rows.values()][0].text.includes("expired yesterday"));
  const second = f.make();
  const related = await second.hydrate("Why did the secure connection fail?", "turn1", 16000);
  assert.equal(related.status, "ok"); assert.match(related.context, /expired yesterday/);
  assert.equal((await second.hydrate("hello", "turn2", 16000)).context, "");
  await second.close();
});

test("cross-scope and replaced transcript anchors never supply hydration", async () => {
  const f = fixture(); const session = f.make(); await session.refresh();
  const foreign = f.make({ ...scope, audience: "other" });
  assert.equal((await foreign.hydrate("TLS", "1", 16000)).context, "");
  f.invalidate();
  assert.equal((await session.hydrate("TLS", "1", 16000)).context, "");
  await session.close(); await foreign.close();
});

test("unresolved and mismatched tool protocols never become historical evidence", async () => {
  const f = fixture(); f.entries[2].message.toolCallId = "wrong";
  const session = f.make(); await session.refresh(); assert.equal(f.rows.size, 0); await session.close();
});

test("excluded nested-tool bookkeeping does not invalidate a completed tool turn", async () => {
  const f = fixture();
  f.entries.splice(2, 0, { entryId: "nested", message: { role: "custom", customType: "openclaw.nested-tool.v1",
    display: true, excludeFromContext: true, content: "" } });
  const session = f.make(); await session.refresh(); assert.equal(f.rows.size, 1); await session.close();
});

test("unknown or content-bearing custom messages still invalidate tool turns", async () => {
  for (const message of [
    { role: "custom", customType: "unknown", display: true, excludeFromContext: true, content: "" },
    { role: "custom", customType: "openclaw.nested-tool.v1", display: true, excludeFromContext: true, content: "instructions" },
  ]) {
    const f = fixture(); f.entries.splice(2, 0, { entryId: "custom", message });
    const session = f.make(); await session.refresh(); assert.equal(f.rows.size, 0); await session.close();
  }
});

test("a changed terminal answer invalidates the stored descriptor", async () => {
  const f = fixture(); const session = f.make(); await session.refresh();
  f.entries[3].message.content = "The previous answer was withdrawn.";
  assert.equal((await session.hydrate("TLS", "1", 16000)).context, "");
  await session.close();
});

test("social reasoning without a tool exchange is not indexed as research", async () => {
  const f = fixture(); f.entries.splice(1, 2);
  const session = f.make(); await session.refresh(); assert.equal(f.rows.size, 0); await session.close();
});

test("social turns preserve active work and low-information continuation restores it", async () => {
  const f = fixture(); const session = f.make(); await session.refresh();
  assert.equal((await session.hydrate("hello", "1", 16000)).context, "");
  assert.match((await session.hydrate("continue", "2", 16000)).context, /expired yesterday/);
  await session.close();
});

test("inactive discourse frames expire before the fifth later user turn", async () => {
  const f = fixture(); const session = f.make(); await session.refresh();
  for (const [key, text] of [["1", "hello"], ["2", "thanks"], ["3", "okay"], ["4", "cool"]])
    assert.equal((await session.hydrate(text, key, 16000)).context, "");
  assert.equal((await session.hydrate("continue", "5", 16000)).context, "");
  await session.close();
});

test("owner keys distinguish identical greetings, but retain retries of one message", async () => {
  const f = fixture(); const session = f.make(); await session.refresh();
  for (let i = 0; i < 5; i++) {
    const message = { role: "user", content: "hello" };
    const key = hydrationTurnKey(message);
    assert.equal(hydrationTurnKey(message), key);
    assert.notEqual(hydrationTurnKey({ ...message }), key);
    await session.hydrate("hello", key, 16000);
    await session.hydrate("hello", key, 16000);
  }
  assert.equal((await session.hydrate("continue", hydrationTurnKey({ role: "user", content: "continue" }), 16000)).context, "");
  const message = { role: "user", content: "hello", id: "entry-1" };
  assert.equal(hydrationTurnKey(message), hydrationTurnKey({ ...message }));
  assert.notEqual(hydrationTurnKey(message), hydrationTurnKey({ ...message, id: "entry-2" }));
  const timestamped = { role: "user", content: "hello", timestamp: 1234 };
  assert.notEqual(hydrationTurnKey(timestamped), hydrationTurnKey({ ...timestamped }));
  await session.close();
});

test("retries alone do not consume the inactivity window", async () => {
  const f = fixture(); const session = f.make(); await session.refresh();
  const message = { role: "user", content: "hello" };
  for (let i = 0; i < 10; i++) await session.hydrate("hello", hydrationTurnKey(message), 16000);
  assert.match((await session.hydrate("continue", "next", 16000)).context, /expired yesterday/);
  const smaller = await session.hydrate("continue", "next", 100);
  assert.ok(Buffer.byteLength(smaller.context) <= 100);
  await session.close();
});

test("unavailable transcript reads do not suspend expiry or topic displacement", async () => {
  for (const prompts of [Array(5).fill("hello"), ["start a database migration"]]) {
    const f = fixture(); const session = f.make(); await session.refresh();
    f.hooks.unavailable = true;
    for (const [i, prompt] of prompts.entries()) await session.hydrate(prompt, String(i), 16000);
    f.hooks.unavailable = false;
    assert.equal((await session.hydrate("continue", "next", 16000)).context, "");
    await session.close();
  }
});

test("a substantive topic change displaces active work", async () => {
  const f = fixture(); const session = f.make(); await session.refresh();
  assert.equal((await session.hydrate("hello", "1", 16000)).context, "");
  assert.equal((await session.hydrate("start a database migration", "2", 16000)).context, "");
  assert.equal((await session.hydrate("continue", "3", 16000)).context, "");
  await session.close();
});

test("transcript catch-up does not reactivate tool work displaced by later discussion", async () => {
  const f = fixture(); f.entries[4].message.content = "start a database migration";
  const session = f.make(); await session.refresh();
  assert.equal((await session.hydrate("continue", "1", 16000)).context, "");
  await session.close();
});

test("continuation intent is a bounded dialogue class, not a substring match", () => {
  assert.equal(classifyHydrationPrompt("Go on."), "continuation");
  assert.equal(classifyHydrationPrompt("okay!"), "social");
  assert.equal(classifyHydrationPrompt("Continue the database migration"), "substantive");
  assert.equal(classifyHydrationPrompt("This is a great migration plan"), "substantive");
});

test("repeated assembly for one user turn reuses the first bounded decision", async () => {
  const f = fixture(); const session = f.make(); await session.refresh();
  const first = await session.hydrate("Why did the TLS connection fail?", "same-turn", 16000);
  const repeated = await session.hydrate("hello", "same-turn", 16000);
  assert.equal(repeated.context, first.context);
  assert.match(repeated.context, /expired yesterday/);
  await session.close();
});

for (const refreshed of [false, true]) test(`same-turn replay rejects a transcript reset (refresh=${refreshed})`, async () => {
  const f = fixture(); const session = f.make(); await session.refresh();
  assert.match((await session.hydrate("TLS", "same", 16000)).context, /expired yesterday/);
  f.invalidate();
  if (refreshed) await session.refresh();
  assert.equal((await session.hydrate("TLS", "same", 16000)).context, "");
  assert.equal((await session.hydrate("continue", "next", 16000)).context, "");
  await session.close();
});

test("same-turn replay revalidates changed evidence and terminal answer", async () => {
  for (const index of [2, 3]) {
    const f = fixture(); const session = f.make(); await session.refresh();
    assert.match((await session.hydrate("TLS", "same", 16000)).context, /expired yesterday/);
    f.entries[index].message.content = "Withdrawn.";
    const repeated = await session.hydrate("TLS", "same", 16000);
    assert.doesNotMatch(repeated.context, /expired yesterday/);
    assert.equal(repeated.hydratedIds.length, 0);
    if (index === 3) assert.equal(repeated.context, "");
    await session.close();
  }
});

test("a reset during hydration cannot publish or reactivate an old packet", async () => {
  const f = fixture(); const session = f.make(); await session.refresh();
  let resume!: () => void; let started!: () => void;
  const waiting = new Promise<void>(resolve => { resume = resolve; });
  const reached = new Promise<void>(resolve => { started = resolve; });
  f.hooks.search = async () => { started(); await waiting; };
  const hydration = session.hydrate("TLS", "same", 16000);
  await reached;
  f.invalidate(); await session.refresh(); f.restore(); resume();
  assert.equal((await hydration).context, "");
  assert.equal((await session.hydrate("continue", "next", 16000)).context, "");
  await session.close();
});

test("long transcript catch-up reaches recent work without requiring user turns", async () => {
  const f = fixture();
  f.entries.unshift(...Array.from({ length: 260 }, (_, i) => ({
    entryId: `old-${i}`, message: { role: i % 2 ? "assistant" : "user", content: i % 2 ? "ack" : `old subject ${i}` },
  })));
  const session = f.make(); await session.refresh();
  assert.equal(f.rows.size, 0, "the first page batch does not reach the tool frame");
  for (let attempt = 0; attempt < 10 && f.rows.size === 0; attempt++)
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.rows.size, 1);
  assert.match((await session.hydrate("continue", "1", 16000)).context, /expired yesterday/);
  await session.close();
});

test("a fenced completed tail is indexed without the next user, only once", async () => {
  const f = fixture(); f.entries.pop();
  const session = f.make(); await session.refresh();
  assert.equal(f.rows.size, 1);
  assert.match((await session.hydrate("continue", "1", 16000)).context, /expired yesterday/);
  for (let i = 2; i <= 6; i++) {
    await session.refresh();
    await session.hydrate("hello", String(i), 16000);
  }
  assert.equal((await session.hydrate("continue", "7", 16000)).context, "");
  assert.equal(f.rows.size, 1);
  await session.close();
});

test("an unresolved fenced tail stays unindexed", async () => {
  const f = fixture(); f.entries.splice(3);
  const session = f.make(); await session.refresh();
  assert.equal(f.rows.size, 0); await session.close();
});

test("timed-out head reads stay bounded and recover after settlement", async () => {
  let release!: (page: any) => void; let reads = 0;
  const reader: TranscriptReader = () => { reads++; return new Promise(resolve => { release = resolve; }); };
  const session = new TranscriptHydration(scope, {} as LibravDBClient, reader, text => text);
  for (let i = 0; i < 4; i++) assert.equal((await session.hydrate("hello", String(i), 16000)).status, "unavailable");
  assert.equal(reads, 1);
  release({ kind: "unavailable" }); await new Promise(resolve => setImmediate(resolve));
  const next = session.hydrate("hello", "next", 16000);
  assert.equal(reads, 2); release({ kind: "unavailable" }); await next;
  await session.close();
});

test("owner publication cannot be rolled back by a late older turn", async () => {
  const source = readFileSync("src/context-engine.ts", "utf8");
  const block = source.slice(source.indexOf("          const key = hydrationTurnKey"), source.indexOf("          if (context && Buffer.byteLength(context)"));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const owner = new AsyncFunction("args", "state", "hydrationTurnKey", "hasLiveToolProtocolAfterLastUser", "approximateMessagesTokens", "approximateTokenCount", "normalizeKernelContent", "logger", "projected", "lastUser", block + "\nreturn context;");
  let finish!: (packet: any) => void;
  const packet = { context: "B evidence", status: "ok", selectedIds: [], hydratedIds: [], elapsedMs: 0 };
  const state = { key: "", adapter: { hydrate: async (q: string) => q === "A" ? new Promise(resolve => { finish = resolve; }) : packet } };
  const run = (id: string, postTool = false) => owner({ messages: [{ id, content: id }], prompt: id, tokenBudget: 20000 }, state, hydrationTurnKey, () => postTool, () => 0, () => 0, (x: string) => x, {}, { messages: [] }, 0);
  const a = run("A"); await run("B"); finish({ ...packet, context: "" }); await a;
  assert.equal(state.key, "id:B");
  assert.equal(await run("B", true), "B evidence");
});

for (const cursor of [undefined, "3", "2"]) test(`all serving reads are bounded when cursor ${cursor} stalls`, async () => {
  const f = fixture(); let stall = false;
  const pending: Array<(page: any) => void> = [];
  const session = f.make(scope, async p => {
    if (stall && p.cursor === cursor) return new Promise(resolve => { pending.push(resolve); });
    return f.read(p);
  });
  await session.refresh();
  assert.equal((await session.hydrate("TLS", "control", 16000)).hydratedIds.length, 1);
  stall = true;
  try {
    for (let i = 0; i < 4; i++) assert.equal((await session.hydrate("TLS", `attempt-${i}`, 16000)).hydratedIds.length, 0);
    assert.ok(pending.length <= 2, `started ${pending.length} unresolved reads`);
  } finally {
    stall = false; for (const resolve of pending) resolve({ kind: "unavailable" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await session.hydrate("TLS", "recovered", 16000)).hydratedIds.length, 1);
    await session.close();
  }
});

test("a pending capture read does not block healthy serving", async () => {
  const f = fixture(); const indexer = f.make(); await indexer.refresh(); await indexer.close();
  let release!: () => void; let entered!: () => void; let first = true;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const session = f.make(scope, async p => {
    if (first) { first = false; entered(); await new Promise<void>(resolve => { release = resolve; }); }
    return f.read(p);
  });
  const capture = session.refresh(); await reached;
  try { assert.equal((await session.hydrate("TLS", "live", 16000)).hydratedIds.length, 1); }
  finally { release(); await capture; await session.close(); }
});

test("rejected SDK reads release their admission slot", async () => {
  const f = fixture(); let reject = false;
  const session = f.make(scope, async p => { if (reject) throw new Error("read failed"); return f.read(p); });
  await session.refresh(); reject = true;
  for (let i = 0; i < 4; i++) await assert.rejects(session.hydrate("TLS", String(i), 16000), /read failed/);
  reject = false;
  assert.equal((await session.hydrate("TLS", "recovered", 16000)).hydratedIds.length, 1);
  await session.close();
});
