import { createHash, randomUUID } from "node:crypto";
import type { HydrationFrame, HydrationScope, EvidenceArchive, HydrationIndex } from "./smart-hydration.js";
import { HydrationWorkingSet } from "./smart-hydration.js";
import type { LibravDBClient } from "./libravdb-client.js";

type Message = { role: string; content: unknown; stopReason?: string; toolCallId?: string;
  customType?: string; display?: boolean; excludeFromContext?: boolean };
type Entry = { entryId: string; message: Message; createdAt?: string };
type Page = { kind: string; cursor?: string; entries?: Entry[]; hasMore?: boolean };
export type TranscriptReader = (params: { sessionId: string; sessionKey: string; cursor?: string; maxBytes: number; maxMessages: number }) => Promise<Page>;
type Located = { entry: Entry; cursor?: string };
type Location = { entryId: string; cursor?: string; block: number; start: number; end: number };
type StoredFrame = { hydrationVersion: 1; frameId: string; frame: HydrationFrame; locations: Record<string, Location>; anchor: Location; terminal: Location; terminalDigest: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const blocks = (m: Message): Record<string, unknown>[] => Array.isArray(m.content) ? m.content : [{ type: "text", text: typeof m.content === "string" ? m.content : "" }];
const blockText = (b: Record<string, unknown>) => typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
const visibleText = (m: Message) => blocks(m).filter(b => b.type === "text").map(blockText).join("\n");
const isExcludedNestedToolActivity = (m: Message) => m.role === "custom" &&
  m.customType === "openclaw.nested-tool.v1" && m.display === true &&
  m.excludeFromContext === true && m.content === "";
const PAGE_BYTES = 1024 * 1024;
// Permit normal capture + serving overlap, but never queue behind stuck SDK I/O.
const MAX_PENDING_TRANSCRIPT_READS = 2;
const messageKeys = new WeakMap<object, string>();
/** Prefer host identity metadata. Without it, never equate separately allocated messages by text. */
export function hydrationTurnKey(message: object): string {
  const value = message as { id?: unknown };
  if (typeof value.id === "string" && value.id) return `id:${value.id}`;
  let key = messageKeys.get(message);
  if (!key) { key = randomUUID(); messageKeys.set(message, key); }
  return key;
}
const SOCIAL = new Set(["hello", "hi", "hey", "thanks", "thank you", "ok", "okay", "got it", "sounds good", "cool", "great", "nice"]);
const CONTINUATION = new Set(["continue", "go on", "keep going", "carry on", "proceed", "resume", "more", "tell me more", "what happened next", "and then", "finish it", "finish that", "back to that", "pick up where we left off"]);

export type HydrationPromptKind = "social" | "continuation" | "substantive";
export function classifyHydrationPrompt(text: string): HydrationPromptKind {
  const words = text.normalize("NFKC").toLocaleLowerCase("en").match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  const phrase = words.join(" ");
  if (SOCIAL.has(phrase)) return "social";
  if (CONTINUATION.has(phrase)) return "continuation";
  return "substantive";
}

/** Canonical transcript pointers; the vector collection holds only compact descriptors. */
export class TranscriptHydration {
  private working: HydrationWorkingSet;
  readonly collection: string;
  private cursor?: string;
  private headReadPending = false;
  private pendingReads = 0;
  private sealedTail?: string;
  private pending: Located[] = [];
  private refreshTask?: Promise<void>;
  private catchupTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private turn = 0;
  private turnKey?: string;
  private topicEpoch = 0;
  private active?: { id: string; lastUsedTurn: number };
  private turnInput?: { key: string; text: string; kind: HydrationPromptKind };
  private generation = 0;

  private reset(cursor?: string) {
    this.generation++; this.topicEpoch++;
    this.cursor = cursor; this.pending = []; this.active = undefined; this.sealedTail = undefined;
    this.turnKey = undefined; this.turnInput = undefined;
    // Replace rather than clear: an older hydration may still be awaiting I/O.
    this.working = new HydrationWorkingSet(this.scope);
  }

  constructor(private readonly scope: HydrationScope, private readonly client: LibravDBClient,
    private readonly read: TranscriptReader, private readonly normalize: (text: string) => string) {
    this.working = new HydrationWorkingSet(scope);
    this.collection = `hydration-v1-${hash(JSON.stringify([scope.tenant, scope.session, scope.audience]))}`;
  }

  private async page(cursor?: string, signal?: AbortSignal): Promise<Page> {
    if (this.closed || signal?.aborted || this.pendingReads >= MAX_PENDING_TRANSCRIPT_READS)
      return { kind: "unavailable" };
    this.pendingReads++;
    try {
      return await this.read({ sessionId: this.scope.session, sessionKey: this.scope.audience, cursor, maxMessages: 1, maxBytes: PAGE_BYTES });
    } finally { this.pendingReads--; }
  }

  private async headPage(): Promise<Page> {
    // A timed-out read may still own I/O. Do not start or attach more reads to it.
    if (this.headReadPending) return { kind: "unavailable" };
    this.headReadPending = true;
    try { return await this.page(this.cursor); }
    finally { this.headReadPending = false; }
  }

  async close() {
    this.closed = true;
    if (this.catchupTimer) clearTimeout(this.catchupTimer);
    await this.refreshTask;
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.refreshTask) return this.refreshTask;
    if (this.catchupTimer) { clearTimeout(this.catchupTimer); this.catchupTimer = undefined; }
    const task = this.capture(this.topicEpoch);
    const settled = task.then(more => {
      if (more && !this.closed) this.catchupTimer = setTimeout(() => {
        this.catchupTimer = undefined;
        void this.refresh().catch(() => {});
      }, 250);
    }).finally(() => { if (this.refreshTask === settled) this.refreshTask = undefined; });
    this.refreshTask = settled;
    return settled;
  }

  private async capture(topicEpoch: number): Promise<boolean> {
    const generation = this.generation;
    const ensured = await this.client.ensureCollections({ collections: [this.collection] }, { timeoutMs: 2000 });
    if (!ensured.ok) throw new Error("Hydration index unavailable");
    let active = this.active;
    const commit = () => { if (topicEpoch === this.topicEpoch) this.active = active; };
    const seal = async () => {
      const tail = this.pending.at(-1)?.entry.entryId;
      if (!tail || tail === this.sealedTail) return;
      const id = await this.store(this.pending);
      if (generation !== this.generation) return;
      if (id) { this.sealedTail = tail; active = { id, lastUsedTurn: this.turn }; }
    };
    // Bounded background catch-up. Future calls resume the cursor.
    for (let n = 0; n < 256 && !this.closed; n++) {
      const page = await this.page(this.cursor);
      if (generation !== this.generation) return false;
      if (page.kind === "reset") { this.reset(page.cursor); return false; }
      if (page.kind !== "page") return false;
      if (!page.entries?.length) { await seal(); commit(); return false; }
      const entry = page.entries[0];
      if (entry.message.role === "user") {
        await seal();
        if (generation !== this.generation) return false;
        if (classifyHydrationPrompt(this.normalize(visibleText(entry.message))) === "substantive") active = undefined;
        this.pending = [];
        this.sealedTail = undefined;
      }
      this.pending.push({ entry, cursor: this.cursor });
      // Oversized turns remain available in original storage, never partly indexed.
      if (this.pending.length > 64 || Buffer.byteLength(JSON.stringify(this.pending)) > 2 * PAGE_BYTES) this.pending = [];
      this.cursor = page.cursor;
      if (!page.hasMore) { await seal(); commit(); return false; }
    }
    commit();
    return !this.closed;
  }

  private async store(turn: Located[]): Promise<string | undefined> {
    const first = turn[0].entry;
    const last = turn.at(-1)!.entry;
    if (first.message.role !== "user" || last.message.role !== "assistant" || last.message.stopReason !== "stop") return;
    const open = new Set<string>(); const seen = new Set<string>();
    for (const { entry: { message } } of turn) {
      if (message.role === "assistant") for (const b of blocks(message)) {
        if (b.type !== "toolCall") continue;
        if (typeof b.id !== "string" || !b.id || seen.has(b.id)) return;
        seen.add(b.id); open.add(b.id);
      }
      else if (message.role === "toolResult" || message.role === "tool") {
        if (!message.toolCallId || !open.delete(message.toolCallId)) return;
      } else if (isExcludedNestedToolActivity(message)) {
        continue;
      } else if (message.role !== "user") return;
    }
    if (open.size || !seen.size || !visibleText(last.message).trim()) return;
    const availableAt = Date.parse(last.createdAt ?? "");
    if (!Number.isFinite(availableAt)) return;
    const id = hash(JSON.stringify([first.entryId, last.entryId, turn[0].cursor, turn.at(-1)!.cursor, hash(visibleText(last.message))]));
    const observed = (value: string, source: string) => ({ value, basis: "observed" as const, sourceIds: [source] });
    const frame: HydrationFrame = { id, revision: id, scope: this.scope, availableAt, status: "completed",
      fields: { what: observed(this.normalize(visibleText(first.message)).slice(0, 512), first.entryId),
        how: observed("Bounded transcript excerpts; evidence and descriptors may omit detail.", first.entryId) },
      outcome: observed(this.normalize(visibleText(last.message)).slice(0, 512), last.entryId), evidence: [], links: [] };
    const locations: Record<string, Location> = {};
    const evidenceOrder = [...turn].sort((a, b) => Number(["toolResult", "tool"].includes(b.entry.message.role)) - Number(["toolResult", "tool"].includes(a.entry.message.role)));
    for (const { entry, cursor } of evidenceOrder) for (const [block, b] of blocks(entry.message).entries()) {
      const kind = b.type === "thinking" ? "historical-analysis" : ["toolResult", "tool"].includes(entry.message.role) && b.type === "text" ? "tool-result" : undefined;
      if (!kind) continue;
      const text = blockText(b);
      // Immutable bounded spans remain individually verifiable and addressable.
      for (let start = 0; start < Math.min(text.length, 2048) && frame.evidence.length < 8; start += 1024) {
        const end = Math.min(start + 1024, text.length);
        const span = text.slice(start, end); const refId = hash(`${entry.entryId}:${block}:${start}`);
        frame.evidence.push({ id: refId, revision: hash(span), sha256: hash(span), utf8Bytes: Buffer.byteLength(span), kind });
        locations[refId] = { entryId: entry.entryId, cursor, block, start, end };
      }
    }
    if (!frame.evidence.length) return;
    const stored: StoredFrame = { hydrationVersion: 1, frameId: id, frame, locations,
      anchor: { entryId: first.entryId, cursor: turn[0].cursor, block: 0, start: 0, end: 0 },
      terminal: { entryId: last.entryId, cursor: turn.at(-1)!.cursor, block: 0, start: 0, end: 0 },
      terminalDigest: hash(visibleText(last.message)) };
    const exists = async () => (await this.client.listByMeta({ collection: this.collection, key: "frameId", value: id }, { timeoutMs: 1000 })).results.some(r => r.id === id);
    if (!await exists()) {
      try {
        const result = await this.client.insertText({ collection: this.collection, id,
          text: `${frame.fields.what!.value}\n${frame.outcome.value}`, metadataJson: Buffer.from(JSON.stringify(stored)) }, { timeoutMs: 5000 });
        if (!result.ok) throw new Error("Hydration frame insertion rejected");
      } catch (error) {
        if (!await exists()) throw error;
      }
    }
    return id;
  }

  async hydrate(text: string, turnKey: string, byteBudget: number) {
    const started = performance.now();
    const empty = () => ({ context: "", selectedIds: [] as string[], hydratedIds: [] as string[], missingIds: [] as string[], deferredIds: [] as string[], status: "unavailable" as const, elapsedMs: performance.now() - started });
    const newTurn = this.turnKey !== turnKey;
    if (newTurn) {
      this.turn++; this.turnKey = turnKey;
      this.turnInput = { key: turnKey, text, kind: classifyHydrationPrompt(text) };
    }
    const turnInput = this.turnInput?.key === turnKey ? this.turnInput : { key: turnKey, text, kind: classifyHydrationPrompt(text) };
    const kind = turnInput.kind;
    if (newTurn && kind === "substantive") { this.topicEpoch++; this.active = undefined; }
    if (this.active && this.turn - this.active.lastUsedTurn >= 5) this.active = undefined;
    const generation = this.generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const head = await Promise.race([
      this.headPage(),
      new Promise<Page>(resolve => { timer = setTimeout(() => resolve({ kind: "unavailable" }), 2000); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (generation !== this.generation || this.turnKey !== turnKey) return empty();
    if (head.kind === "reset") { this.reset(head.cursor); return empty(); }
    if (head.kind !== "page") return empty();
    const continuityId = kind === "continuation" ? this.active?.id : undefined;
    const stored = new Map<string, StoredFrame>(); const scores = new Map<string, number>();
    const parse = async (r: { id: string; metadataJson: Uint8Array }, signal: AbortSignal): Promise<HydrationFrame | undefined> => {
      if (signal.aborted || r.metadataJson.length > 32768) return;
      const value = JSON.parse(Buffer.from(r.metadataJson).toString()) as StoredFrame;
      if (value.hydrationVersion !== 1 || value.frameId !== r.id || value.frame.id !== r.id ||
          value.frame.scope.tenant !== this.scope.tenant || value.frame.scope.session !== this.scope.session ||
          value.frame.scope.audience !== this.scope.audience) return;
      if (!value.frame.evidence.some(ref => ref.kind === "tool-result")) return;
      const page = await this.page(value.anchor.cursor, signal);
      if (page.kind !== "page" || page.entries?.[0]?.entryId !== value.anchor.entryId) return;
      const terminal = await this.page(value.terminal.cursor, signal);
      const end = terminal.entries?.[0];
      if (terminal.kind !== "page" || end?.entryId !== value.terminal.entryId ||
          hash(visibleText(end.message)) !== value.terminalDigest) return;
      stored.set(r.id, value); return value.frame;
    };
    const index: HydrationIndex = {
      get: async ({ ids, signal }) => {
        const out: HydrationFrame[] = [];
        for (const id of ids) {
          const result = await this.client.listByMeta({ collection: this.collection, key: "frameId", value: id }, { signal, timeoutMs: 1000 });
          for (const r of result.results.slice(0, 1)) { const f = await parse(r, signal); if (f) out.push(f); }
        }
        return out;
      },
      nominate: async ({ limit, signal }) => {
        if (kind === "social") return [];
        const result = await this.client.searchText({ collection: this.collection, text: turnInput.text, k: Math.min(5, limit) }, { signal, timeoutMs: 1000 });
        const out: HydrationFrame[] = [];
        for (const r of result.results.slice(0, limit)) {
          if (!Number.isFinite(r.score) || r.score < 0.75) continue;
          const f = await parse(r, signal); if (f) { scores.set(f.id, r.score); out.push(f); }
        }
        return out;
      },
      rank: async ({ candidates }) => candidates.filter(f => scores.has(f.id)).map(f => ({ id: f.id, score: scores.get(f.id)! })),
    };
    const archive: EvidenceArchive = { read: async ({ eventId, ref, signal }) => {
      if (signal.aborted) return;
      const loc = stored.get(eventId)?.locations[ref.id]; if (!loc) return;
      const page = await this.page(loc.cursor, signal);
      const entry = page.entries?.[0];
      if (signal.aborted || page.kind !== "page" || entry?.entryId !== loc.entryId) return;
      const b = blocks(entry.message)[loc.block]; if (!b) return;
      return { scope: this.scope, eventId, id: ref.id, revision: ref.revision, text: blockText(b).slice(loc.start, loc.end) };
    } };
    const packet = await this.working.hydrate({ scope: this.scope, turn: this.turn,
      query: { text: turnInput.text, recentFrames: [], referencedIds: continuityId ? [continuityId] : [] },
      asOf: Date.now(), policy: { candidates: 10, frames: 2, evidenceReads: 4, byteBudget, timeoutMs: Math.max(1, Math.floor(2000 - (performance.now() - started))), minimumScore: 0.75 }, index, archive });
    if (generation !== this.generation || this.turnKey !== turnKey) return empty();
    if (kind === "substantive") this.active = packet.context && packet.selectedIds.length
      ? { id: packet.selectedIds[0], lastUsedTurn: this.turn } : undefined;
    else if (kind === "continuation" && continuityId && packet.context && packet.selectedIds.includes(continuityId))
      this.active = { id: continuityId, lastUsedTurn: this.turn };
    return { ...packet, elapsedMs: performance.now() - started };
  }
}
