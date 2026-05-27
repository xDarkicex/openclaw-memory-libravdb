import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMarkdownIngestionHandle } from "../../src/markdown-ingest.js";

type FsDirentLike = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
};

class FakeRpcClient {
  calls: Array<{ method: string; params: unknown }> = [];
  documents = new Map<string, { text: string; tokenizerId: string; coreDoc: boolean; sourceMeta: Record<string, unknown> }>();
  feedbackSupplier?: (sourceDoc: string, callIndex: number) => Record<string, unknown> | undefined;

  private ingestCallCount = 0;

  async ingestMarkdownDocument(params: {
    sourceDoc: string;
    text: string;
    tokenizerId: string;
    coreDoc: boolean;
    sourceMeta: Record<string, unknown>;
    mode?: number;
  }): Promise<{ ok: boolean; feedback?: Record<string, unknown> }> {
    this.calls.push({ method: "ingest_markdown_document", params });
    const { sourceDoc, text, tokenizerId, coreDoc, sourceMeta } = params;
    this.documents.set(sourceDoc, { text, tokenizerId, coreDoc, sourceMeta });
    const callIdx = this.ingestCallCount++;
    const feedback = this.feedbackSupplier?.(sourceDoc, callIdx);
    return feedback ? { ok: true, feedback } : { ok: true };
  }

  async deleteAuthoredDocument(params: { sourceDoc: string }): Promise<{ ok: boolean }> {
    this.calls.push({ method: "delete_authored_document", params });
    this.documents.delete(params.sourceDoc);
    return { ok: true };
  }
}

class FakeFsApi {
  // in-memory filesystem: absolute path → file entry
  private files = new Map<string, { content: Buffer; mtimeMs: number; ctimeMs: number }>();
  // directory set — tracked so readdir works without scanning files map
  private dirs = new Set<string>();

  callbacks = new Map<string, Array<(event: string, filename: string | Buffer | null) => void>>();

  // ── seed helpers (called by tests instead of real fsp) ──────────────

  async mkdir(dir: string, _opts?: { recursive?: boolean }): Promise<void> {
    // register this dir and all ancestors
    let current = path.resolve(dir);
    while (true) {
      this.dirs.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  async writeFile(filePath: string, content: string | Buffer, mtimeMs?: number): Promise<void> {
    const abs = path.resolve(filePath);
    await this.mkdir(path.dirname(abs));
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const now = Date.now();
    this.files.set(abs, {
      content: buf,
      mtimeMs: mtimeMs ?? now,
      ctimeMs: now,
    });
  }

  async utimes(filePath: string, _atime: number, mtimeMs: number): Promise<void> {
    const abs = path.resolve(filePath);
    const entry = this.files.get(abs);
    if (entry) {
      entry.mtimeMs = mtimeMs * 1000; // utimes receives seconds
    }
  }

  async rm(filePath: string): Promise<void> {
    this.files.delete(path.resolve(filePath));
  }

  // ── FsApi interface ──────────────────────────────────────────────────

  async readdir(dir: string): Promise<FsDirentLike[]> {
    const abs = path.resolve(dir);
    const results: FsDirentLike[] = [];
    const prefix = abs.endsWith(path.sep) ? abs : abs + path.sep;

    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (!rest.includes(path.sep)) {
        results.push({
          name: rest,
          isDirectory: () => false,
          isFile: () => true,
        });
      }
    }

    for (const d of this.dirs) {
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (rest && !rest.includes(path.sep)) {
        results.push({
          name: rest,
          isDirectory: () => true,
          isFile: () => false,
        });
      }
    }

    return results;
  }

  async stat(filePath: string): Promise<{ size: number; mtimeMs: number; ctimeMs: number }> {
    const entry = this.files.get(path.resolve(filePath));
    if (!entry) throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
    return { size: entry.content.byteLength, mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs };
  }

  async readFile(filePath: string): Promise<Buffer> {
    const entry = this.files.get(path.resolve(filePath));
    if (!entry) throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
    return entry.content;
  }

  async openReadStream(filePath: string): Promise<{ read(buf: Buffer): Promise<{ bytesRead: number }>; close(): Promise<void> }> {
    const entry = this.files.get(path.resolve(filePath));
    if (!entry) throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
    let offset = 0;
    const content = entry.content;
    return {
      async read(buf: Buffer): Promise<{ bytesRead: number }> {
        const remaining = content.byteLength - offset;
        if (remaining <= 0) return { bytesRead: 0 };
        const bytesRead = Math.min(buf.byteLength, remaining);
        content.copy(buf, 0, offset, offset + bytesRead);
        offset += bytesRead;
        return { bytesRead };
      },
      async close(): Promise<void> {},
    };
  }

  watch(dir: string, onChange: (event: string, filename: string | Buffer | null) => void) {
    const callbacks = this.callbacks.get(dir) ?? [];
    callbacks.push(onChange);
    this.callbacks.set(dir, callbacks);
    return {
      close: () => {
        const next = (this.callbacks.get(dir) ?? []).filter((cb) => cb !== onChange);
        if (next.length > 0) {
          this.callbacks.set(dir, next);
        } else {
          this.callbacks.delete(dir);
        }
      },
      on: () => {},
    };
  }

  triggerAll(event = "change"): void {
    for (const [dir, callbacks] of this.callbacks.entries()) {
      for (const callback of callbacks) {
        callback(event, path.basename(dir));
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotPath(tempRoot: string, kind: "generic" | "obsidian" = "generic"): string {
  return path.join(tempRoot, `${kind}-snapshot.json`);
}

test("markdown ingestion roots stay inert unless explicitly enabled", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-markdown-disabled-"));
  const filePath = path.join(tempRoot, "MEMORY.md");
  await fsp.writeFile(filePath, "# Memory\n\nThis root is configured but not enabled.");

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionRoots: [tempRoot],
      markdownIngestionDebounceMs: 0,
    },
    async () => rpc as never,
    console,
    fsApi as never,
  );

  await handle.start();
  fsApi.triggerAll("change");
  await delay(25);

  assert.equal(rpc.calls.length, 0);
  assert.equal(fsApi.callbacks.size, 0);

  await handle.stop();
});

test("obsidian roots stay inert unless explicitly enabled", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-obsidian-disabled-"));
  const filePath = path.join(tempRoot, "tagged.md");
  await fsp.writeFile(filePath, "# Project #openclaw\n\nThis vault root is configured but not enabled.");

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: false,
      markdownIngestionObsidianRoots: [tempRoot],
      markdownIngestionObsidianDebounceMs: 0,
    },
    async () => rpc as never,
    console,
    fsApi as never,
  );

  await handle.start();
  fsApi.triggerAll("change");
  await delay(25);

  assert.equal(rpc.calls.length, 0);
  assert.equal(fsApi.callbacks.size, 0);

  await handle.stop();
});

test("markdown ingestion forwards raw markdown to the go sidecar and stays hash-stable", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-markdown-"));
  const nestedDir = path.join(tempRoot, "skills", "alpha");
  const filePath = path.join(nestedDir, "guide.md");

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  await fsApi.mkdir(nestedDir, { recursive: true });

  await fsApi.writeFile(
    filePath,
    [
      "# Policy",
      "You must keep the prompt lean.",
      "",
      "## Notes",
      "You should avoid raw blob imports.",
    ].join("\n"),
  );

  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: snapshotPath(tempRoot),
    },
    async () => rpc as never,
    console,
    fsApi as never,
  );

  await handle.start();

  assert.equal(rpc.calls.filter((call) => call.method === "ingest_markdown_document").length, 1);
  assert.equal(rpc.documents.get(filePath)?.text.includes("keep the prompt lean"), true);
  assert.equal(rpc.documents.get(filePath)?.sourceMeta.sourceKind, "generic");

  await fsApi.writeFile(
    filePath,
    [
      "# Policy",
      "You must keep the prompt lean.",
      "",
      "## Notes",
      "You should avoid raw blob imports.",
    ].join("\n"),
  );

  fsApi.triggerAll("change");
  await delay(25);

  assert.equal(rpc.calls.filter((call) => call.method === "ingest_markdown_document").length, 1, "unchanged content should not reingest");

  await fsApi.writeFile(
    filePath,
    [
      "# Policy",
      "You must keep the prompt lean.",
      "",
      "## Notes",
      "You should avoid duplicate inserts on change.",
    ].join("\n"),
  );

  fsApi.triggerAll("change");
  await delay(25);

  assert.equal(rpc.calls.filter((call) => call.method === "ingest_markdown_document").length, 2, "changed content should reingest once");
  assert.equal(rpc.documents.get(filePath)?.text.includes("duplicate inserts on change"), true);

  await fsApi.rm(filePath);
  fsApi.triggerAll("change");
  await delay(25);

  assert.equal(rpc.calls.filter((call) => call.method === "delete_authored_document").length, 1, "file deletion should prune authored docs");
  assert.equal(rpc.documents.has(filePath), false);

  await handle.stop();
});

test("obsidian markdown ingestion flips source kind while reusing the same rpc path", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-obsidian-"));
  const filePath = path.join(tempRoot, "memory.md");

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  await fsApi.writeFile(
    filePath,
    [
      "---",
      "tags: [openclaw]",
      "---",
      "",
      "# Vault",
      "You must keep the vault synced.",
    ].join("\n"),
  );

  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: false,
      markdownIngestionObsidianEnabled: true,
      markdownIngestionObsidianRoots: [tempRoot],
      markdownIngestionObsidianDebounceMs: 0,
      markdownIngestionObsidianSnapshotPath: snapshotPath(tempRoot, "obsidian"),
    },
    async () => rpc as never,
    console,
    fsApi as never,
  );

  await handle.start();

  assert.equal(rpc.calls.filter((call) => call.method === "ingest_markdown_document").length, 1);
  assert.equal(rpc.documents.get(filePath)?.sourceMeta.sourceKind, "obsidian");

  await handle.stop();
});

test("obsidian markdown ingestion skips untaged notes by default", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-obsidian-skip-"));
  const filePath = path.join(tempRoot, "scratch.md");

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  await fsApi.writeFile(
    filePath,
    [
      "# Scratch",
      "This note has no frontmatter tags.",
    ].join("\n"),
  );

  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: false,
      markdownIngestionObsidianEnabled: true,
      markdownIngestionObsidianRoots: [tempRoot],
      markdownIngestionObsidianDebounceMs: 0,
      markdownIngestionObsidianSnapshotPath: snapshotPath(tempRoot, "obsidian"),
    },
    async () => rpc as never,
    console,
    fsApi as never,
  );

  await handle.start();

  assert.equal(rpc.calls.filter((call) => call.method === "ingest_markdown_document").length, 0);
  assert.equal(rpc.documents.has(filePath), false);

  await handle.stop();
});

test("markdown ingestion always includes MEMORY.md by filename even under narrow include globs", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-memory-file-"));
  const filePath = path.join(tempRoot, "MEMORY.md");

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  await fsApi.writeFile(
    filePath,
    [
      "# Memory",
      "This stock memory note has no tags but should still ingest.",
    ].join("\n"),
  );

  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionInclude: ["skills/*/*.md"],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: snapshotPath(tempRoot),
    },
    async () => rpc as never,
    console,
    fsApi as never,
  );

  await handle.start();

  assert.equal(rpc.calls.filter((call) => call.method === "ingest_markdown_document").length, 1);
  assert.equal(rpc.documents.get(filePath)?.sourceMeta.sourceKind, "generic");

  await handle.stop();
});

test("obsidian markdown ingestion accepts inline tags like #project", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-obsidian-inline-"));
  const filePath = path.join(tempRoot, "project-note.md");

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  await fsApi.writeFile(
    filePath,
    [
      "# Vault",
      "This note mentions #project and should ingest.",
      "```ts",
      "const example = '#ignore-me';",
      "```",
    ].join("\n"),
  );

  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: false,
      markdownIngestionObsidianEnabled: true,
      markdownIngestionObsidianRoots: [tempRoot],
      markdownIngestionObsidianDebounceMs: 0,
      markdownIngestionObsidianSnapshotPath: snapshotPath(tempRoot, "obsidian"),
    },
    async () => rpc as never,
    console,
    fsApi as never,
  );

  await handle.start();

  assert.equal(rpc.calls.filter((call) => call.method === "ingest_markdown_document").length, 1);
  assert.equal(rpc.documents.get(filePath)?.sourceMeta.sourceKind, "obsidian");

  await handle.stop();
});

test("obsidian markdown ingestion accepts CRLF frontmatter tags", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-obsidian-crlf-"));
  const filePath = path.join(tempRoot, "windows-note.md");

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  await fsApi.writeFile(
    filePath,
    [
      "---",
      "tags: [openclaw]",
      "---",
      "",
      "# Vault",
      "This note uses CRLF frontmatter.",
    ].join("\r\n"),
  );

  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: false,
      markdownIngestionObsidianEnabled: true,
      markdownIngestionObsidianRoots: [tempRoot],
      markdownIngestionObsidianDebounceMs: 0,
      markdownIngestionObsidianSnapshotPath: snapshotPath(tempRoot, "obsidian"),
    },
    async () => rpc as never,
    console,
    fsApi as never,
  );

  await handle.start();

  assert.equal(rpc.calls.filter((call) => call.method === "ingest_markdown_document").length, 1);
  assert.equal(rpc.documents.get(filePath)?.sourceMeta.sourceKind, "obsidian");

  await handle.stop();
});

test("obsidian markdown ingestion accepts tags in headings", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-obsidian-heading-tag-"));
  const filePath = path.join(tempRoot, "heading-tag.md");

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  await fsApi.writeFile(
    filePath,
    [
      "# Project #openclaw",
      "This note only has an Obsidian tag in the heading.",
    ].join("\n"),
  );

  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: false,
      markdownIngestionObsidianEnabled: true,
      markdownIngestionObsidianRoots: [tempRoot],
      markdownIngestionObsidianDebounceMs: 0,
      markdownIngestionObsidianSnapshotPath: snapshotPath(tempRoot, "obsidian"),
    },
    async () => rpc as never,
    console,
    fsApi as never,
  );

  await handle.start();

  assert.equal(rpc.calls.filter((call) => call.method === "ingest_markdown_document").length, 1);
  assert.equal(rpc.documents.get(filePath)?.sourceMeta.sourceKind, "obsidian");

  await handle.stop();
});

test("markdown ingestion stop waits for an in-flight startup scan", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-md-stop-"));
  const notePath = path.join(tempRoot, "slow.md");
  await fsp.writeFile(notePath, "# Slow note\n\nThis scan is intentionally held open.");

  let callStarted!: () => void;
  const callStartedPromise = new Promise<void>((resolve) => {
    callStarted = resolve;
  });
  let releaseCall!: () => void;
  const releaseCallPromise = new Promise<void>((resolve) => {
    releaseCall = resolve;
  });
  let rpcCompleted = false;

  const rpc = {
    async ingestMarkdownDocument(_params: unknown) {
      callStarted();
      await releaseCallPromise;
      rpcCompleted = true;
      return { ok: true };
    },
  };

  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: snapshotPath(tempRoot),
    },
    async () => rpc as never,
    { error() {}, warn() {} },
  );

  const startPromise = handle.start();
  await callStartedPromise;

  let stopResolved = false;
  const stopPromise = handle.stop().then(() => {
    stopResolved = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopResolved, false, "stop must wait for the in-flight scan before resolving");
  assert.equal(rpcCompleted, false, "the held RPC should still be in flight");

  releaseCall();
  await stopPromise;
  await startPromise;
  assert.equal(rpcCompleted, true);
});

test("markdown ingestion prunes excluded directories before recursion", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-md-prune-"));
  const docsDir = path.join(tempRoot, "docs");
  const nodeModulesDir = path.join(tempRoot, "node_modules", "pkg");
  const includedPath = path.join(docsDir, "guide.md");
  const excludedPath = path.join(nodeModulesDir, "README.md");

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  await fsApi.mkdir(docsDir, { recursive: true });
  await fsApi.mkdir(nodeModulesDir, { recursive: true });
  await fsApi.writeFile(includedPath, "# Guide\n\nThis should ingest.");
  await fsApi.writeFile(excludedPath, "# Package\n\nThis should not even be walked.");

  const infoMessages: string[] = [];
  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionExclude: ["node_modules/**", "**/node_modules/**"],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: path.join(tempRoot, "snapshot.json"),
    },
    async () => rpc as never,
    { error() {}, warn() {}, info: (message: string) => infoMessages.push(message) },
    fsApi as never,
  );

  await handle.start();

  assert.equal(rpc.calls.filter((call) => call.method === "ingest_markdown_document").length, 1);
  assert.equal(rpc.documents.has(includedPath), true);
  assert.equal(rpc.documents.has(excludedPath), false);
  assert.equal([...fsApi.callbacks.keys()].some((watched) => watched.includes(`${path.sep}node_modules`)), false);
  assert.equal(infoMessages.some((message) => message.includes("prunedDirs=1")), true);

  await handle.stop();
});

test("markdown ingestion persists snapshots across adapter restarts", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-md-snapshot-"));
  const filePath = path.join(tempRoot, "guide.md");
  const snapshotPath = path.join(tempRoot, "snapshot.json");
  await fsp.writeFile(filePath, "# Guide\n\nThis should ingest once across restarts.");

  const firstRpc = new FakeRpcClient();
  const firstHandle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: snapshotPath,
    },
    async () => firstRpc as never,
    { error() {}, warn() {}, info() {} },
  );

  await firstHandle.start();
  await firstHandle.stop();

  assert.equal(firstRpc.calls.filter((call) => call.method === "ingest_markdown_document").length, 1);
  assert.equal(JSON.parse(await fsp.readFile(snapshotPath, "utf8")).files[filePath].sourceDoc, filePath);

  const secondRpc = new FakeRpcClient();
  const infoMessages: string[] = [];
  const secondHandle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: snapshotPath,
    },
    async () => secondRpc as never,
    { error() {}, warn() {}, info: (message: string) => infoMessages.push(message) },
  );

  await secondHandle.start();

  assert.equal(secondRpc.calls.filter((call) => call.method === "ingest_markdown_document").length, 0);
  assert.equal(infoMessages.some((message) => message.includes("loaded 1 generic file snapshots")), true);
  assert.equal(infoMessages.some((message) => message.includes("unchanged=1")), true);

  await secondHandle.stop();
});

test("markdown ingestion startup processes newest files first in mtime mode", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-md-priority-"));
  const oldestPath = path.join(tempRoot, "old.md");
  const newestPath = path.join(tempRoot, "new.md");
  await fsp.writeFile(oldestPath, "# Old\n\noldest");
  await fsp.writeFile(newestPath, "# New\n\nnewest");
  const now = Date.now();
  await fsp.utimes(oldestPath, now / 1000, (now - 5000) / 1000);
  await fsp.utimes(newestPath, now / 1000, now / 1000);

  const rpc = new FakeRpcClient();
  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: snapshotPath(tempRoot),
      markdownIngestionPriorityMode: "mtime",
    },
    async () => rpc as never,
    { error() {}, warn() {}, info() {} },
  );

  await handle.start();

  const ingestCalls = rpc.calls.filter((call) => call.method === "ingest_markdown_document");
  assert.equal(ingestCalls.length, 2);
  assert.equal((ingestCalls[0].params as { sourceDoc: string }).sourceDoc, newestPath);
  assert.equal((ingestCalls[1].params as { sourceDoc: string }).sourceDoc, oldestPath);

  await handle.stop();
});

test("markdown ingestion startup defers files exceeding per-file max token cap", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-md-budget-"));
  const smallPath = path.join(tempRoot, "small.md");
  const mediumPath = path.join(tempRoot, "medium.md");
  const oversizedPath = path.join(tempRoot, "oversized.md");
  await fsp.writeFile(smallPath, "# Small\n\nok");
  await fsp.writeFile(mediumPath, "# Medium\n\n" + "m".repeat(900));
  await fsp.writeFile(oversizedPath, "# Oversized\n\n" + "x".repeat(1200));

  const rpc = new FakeRpcClient();
  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: snapshotPath(tempRoot),
      markdownIngestionPriorityMode: "fifo",
      markdownIngestionMaxTokensPerFile: 200,
    },
    async () => rpc as never,
    { error() {}, warn() {}, info() {} },
  );

  try {
    await handle.start();

    const ingested = rpc.calls
      .filter((call) => call.method === "ingest_markdown_document")
      .map((call) => (call.params as { sourceDoc: string }).sourceDoc);
    assert.equal(ingested.includes(smallPath), true);
    assert.equal(ingested.includes(mediumPath), false);
    assert.equal(ingested.includes(oversizedPath), false);
  } finally {
    await handle.stop();
  }
});

test("markdown ingestion startup streams reads without fsApi.readFile dependency", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-md-stream-"));
  const filePath = path.join(tempRoot, "stream.md");

  const rpc = new FakeRpcClient();
  const fsBase = new FakeFsApi();
  await fsBase.writeFile(filePath, "# Stream\n\n" + "s".repeat(5000));

  const fsApi = {
    readdir: fsBase.readdir.bind(fsBase),
    stat: fsBase.stat.bind(fsBase),
    watch: fsBase.watch.bind(fsBase),
    openReadStream: fsBase.openReadStream.bind(fsBase),
    readFile: async (_file: string) => {
      throw new Error("readFile should not be called when streaming ingest is enabled");
    },
  };
  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: snapshotPath(tempRoot),
    },
    async () => rpc as never,
    { error() {}, warn() {}, info() {} },
    fsApi as never,
  );

  try {
    await handle.start();
    assert.equal(rpc.calls.filter((call) => call.method === "ingest_markdown_document").length, 3);
  } finally {
    await handle.stop();
  }
});

test("backpressure resume cursor skips already-processed files on retry scan", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-md-resume-"));
  const newestPath = path.join(tempRoot, "03-newest.md");
  const middlePath = path.join(tempRoot, "02-middle.md");
  const oldestPath = path.join(tempRoot, "01-oldest.md");
  const now = Date.now();
  await fsp.writeFile(newestPath, "# Newest\n\nMost recently modified.");
  await fsp.writeFile(middlePath, "# Middle\n\nMiddle recency.");
  await fsp.writeFile(oldestPath, "# Oldest\n\nOldest file.");
  await fsp.utimes(newestPath, now / 1000, now / 1000);
  await fsp.utimes(middlePath, now / 1000, (now - 2000) / 1000);
  await fsp.utimes(oldestPath, now / 1000, (now - 4000) / 1000);

  let ingestCallCount = 0;
  const rpc = new FakeRpcClient();
  rpc.feedbackSupplier = (_sourceDoc: string, _callIndex: number) => {
    ingestCallCount++;
    if (ingestCallCount === 1) {
      return { acceptMore: false, retryAfterMs: 50 };
    }
    return { acceptMore: true, retryAfterMs: 0 };
  };

  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: snapshotPath(tempRoot),
      markdownIngestionPriorityMode: "mtime",
    },
    async () => rpc as never,
    { error() {}, warn() {}, info() {} },
  );

  try {
    await handle.start();

    const firstPassCalls = rpc.calls.filter((call) => call.method === "ingest_markdown_document");
    assert.equal(firstPassCalls.length, 1, "first scan should ingest only one file before backpressure");
    // With mtime sort, the newest file is first
    assert.equal(
      (firstPassCalls[0].params as { sourceDoc: string }).sourceDoc,
      newestPath,
      "first ingested file should be the newest file",
    );

    await delay(200);

    const allIngestCalls = rpc.calls.filter((call) => call.method === "ingest_markdown_document");
    assert.equal(allIngestCalls.length, 3, "resume scan should ingest remaining files");
    const ingestedPaths = allIngestCalls.map((call) => (call.params as { sourceDoc: string }).sourceDoc);
    assert.equal(ingestedPaths.filter((p) => p === newestPath).length, 1, "newest file ingested exactly once");
    assert.equal(ingestedPaths.includes(middlePath), true, "middle file should be ingested on resume");
    assert.equal(ingestedPaths.includes(oldestPath), true, "oldest file should be ingested on resume");
  } finally {
    await handle.stop();
  }
});

test("resume cursor invalidates when target file is deleted during pause", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-md-resume-deleted-"));
  const firstPath = path.join(tempRoot, "first.md");
  const secondPath = path.join(tempRoot, "second.md");
  const now = Date.now();

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  let ingestCount = 0;
  rpc.feedbackSupplier = (_sourceDoc: string, _callIndex: number) => {
    ingestCount++;
    if (ingestCount === 1) {
      return { acceptMore: false, retryAfterMs: 5000 };
    }
    return { acceptMore: true, retryAfterMs: 0 };
  };

  await fsApi.writeFile(firstPath, "# First\n\nFirst file.");
  await fsApi.writeFile(secondPath, "# Second\n\nSecond file.");
  await fsApi.utimes(firstPath, now / 1000, now / 1000);
  await fsApi.utimes(secondPath, now / 1000, (now - 2000) / 1000);

  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: snapshotPath(tempRoot),
      markdownIngestionPriorityMode: "mtime",
    },
    async () => rpc as never,
    { error() {}, warn() {}, info() {} },
    fsApi as never,
  );

  try {
    await handle.start();

    const afterFirstPass = rpc.calls.filter((call) => call.method === "ingest_markdown_document");
    assert.equal(afterFirstPass.length, 1, "first file should be ingested before backpressure");
    assert.equal(
      (afterFirstPass[0].params as { sourceDoc: string }).sourceDoc,
      firstPath,
      "first ingested file is the newest file",
    );

    await fsApi.rm(secondPath);
    await handle.refresh();

    const allCalls = rpc.calls;
    const ingestCalls = allCalls.filter((call) => call.method === "ingest_markdown_document");
    const deleteCalls = allCalls.filter((call) => call.method === "delete_authored_document");
    assert.equal(ingestCalls.length, 1, "no additional ingest calls after resume with deleted cursor target");
    assert.equal(deleteCalls.length, 1, "deleted cursor target should produce a delete call");
  } finally {
    await handle.stop();
  }
});

test("watcher-triggered scan resets resume cursor for full re-scan", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-md-watcher-reset-"));
  const firstPath = path.join(tempRoot, "first.md");
  const secondPath = path.join(tempRoot, "second.md");
  const now = Date.now();

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  let ingestCount = 0;
  rpc.feedbackSupplier = (_sourceDoc: string, _callIndex: number) => {
    ingestCount++;
    if (ingestCount === 1) {
      return { acceptMore: false, retryAfterMs: 5000 };
    }
    return { acceptMore: true, retryAfterMs: 0 };
  };

  await fsApi.writeFile(firstPath, "# First\n\nOriginal content.");
  await fsApi.writeFile(secondPath, "# Second\n\nSecond file.");
  await fsApi.utimes(firstPath, now / 1000, now / 1000);
  await fsApi.utimes(secondPath, now / 1000, (now - 2000) / 1000);

  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: snapshotPath(tempRoot),
      markdownIngestionPriorityMode: "mtime",
    },
    async () => rpc as never,
    { error() {}, warn() {}, info() {} },
    fsApi as never,
  );

  try {
    await handle.start();

    // First scan: newest file (firstPath) ingested, backpressure fires, cursor = secondPath
    const afterFirstPass = rpc.calls.filter((call) => call.method === "ingest_markdown_document");
    assert.equal(afterFirstPass.length, 1, "first file ingested before backpressure");
    assert.equal(
      (afterFirstPass[0].params as { sourceDoc: string }).sourceDoc,
      firstPath,
      "first ingested file is the newest file",
    );

    // Modify secondPath to trigger a watcher event; watcher clears cursor + timer
    await fsApi.writeFile(secondPath, "# Second\n\nModified to trigger watcher.");
    await delay(50);

    // Watcher-triggered full scan: firstPath unchanged (skip), secondPath changed → ingest
    const allIngestCalls = rpc.calls.filter((call) => call.method === "ingest_markdown_document");
    assert.equal(allIngestCalls.length, 2, "watcher-triggered scan does full re-scan from top");
  } finally {
    await handle.stop();
  }
});

test("ingest feedback interface stores all 8 daemon fields without dropping any", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-md-feedback-"));
  const filePath = path.join(tempRoot, "single.md");
  await fsp.writeFile(filePath, "# Single\n\nOne file to test full feedback passthrough.");

  const rpc = new FakeRpcClient();
  rpc.feedbackSupplier = () => ({
    queueDepth: 42,
    queueCapacity: 100,
    acceptMore: true,
    retryAfterMs: 0,
    processingTimeUs: 1234,
    nodesAccepted: 5,
    nodesRejected: 2,
    tokensIngested: 3200,
  });

  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: snapshotPath(tempRoot),
    },
    async () => rpc as never,
    { error() {}, warn() {}, info() {} },
  );

  try {
    await handle.start();

    const ingestCalls = rpc.calls.filter((call) => call.method === "ingest_markdown_document");
    assert.equal(ingestCalls.length, 1, "file should be ingested with full feedback present");
    const callParams = ingestCalls[0].params as { sourceDoc: string };
    assert.equal(callParams.sourceDoc, filePath, "correct file ingested");
  } finally {
    await handle.stop();
  }
});

test("REPLACE and APPEND ingest modes are unaffected by feedback interface changes", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-md-ordinal-"));
  const filePath = path.join(tempRoot, "append-guard.md");
  await fsp.writeFile(filePath, "# Large\n\n" + "L".repeat(40000));

  const rpc = new FakeRpcClient();
  rpc.feedbackSupplier = () => ({
    queueDepth: 5,
    queueCapacity: 50,
    acceptMore: true,
    retryAfterMs: 0,
    processingTimeUs: 900,
    nodesAccepted: 3,
    nodesRejected: 0,
    tokensIngested: 1000,
  });

  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: snapshotPath(tempRoot),
    },
    async () => rpc as never,
    { error() {}, warn() {}, info() {} },
  );

  try {
    await handle.start();

    const ingestCalls = rpc.calls.filter((call) => call.method === "ingest_markdown_document");
    assert.equal(ingestCalls.length, 20, "large file should be split into multiple chunks");
    assert.equal(
      (ingestCalls[0].params as { mode: number }).mode,
      0,
      "first chunk should use REPLACE mode",
    );
    assert.equal(
      (ingestCalls[1].params as { mode: number }).mode,
      1,
      "second chunk should use APPEND mode",
    );
  } finally {
    await handle.stop();
  }
});

test("markdown ingestion default-excludes dependency and build directories", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-md-default-exclude-"));
  const keepPath = path.join(tempRoot, "docs", "guide.md");
  const nodeModulesPath = path.join(tempRoot, "node_modules", "pkg", "CHANGELOG.md");
  const gitPath = path.join(tempRoot, ".git", "README.md");
  const distPath = path.join(tempRoot, "dist", "README.md");
  const nestedNodeModulesPath = path.join(tempRoot, "packages", "app", "node_modules", "pkg", "README.md");
  const nestedBuildPath = path.join(tempRoot, "packages", "app", "build", "README.md");

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  await fsApi.mkdir(path.dirname(keepPath), { recursive: true });
  await fsApi.mkdir(path.dirname(nodeModulesPath), { recursive: true });
  await fsApi.mkdir(path.dirname(gitPath), { recursive: true });
  await fsApi.mkdir(path.dirname(distPath), { recursive: true });
  await fsApi.mkdir(path.dirname(nestedNodeModulesPath), { recursive: true });
  await fsApi.mkdir(path.dirname(nestedBuildPath), { recursive: true });
  await fsApi.writeFile(keepPath, "# Keep\n\nUser-authored doc.");
  await fsApi.writeFile(nodeModulesPath, "# Changelog\n\nDependency docs.");
  await fsApi.writeFile(gitPath, "# Git internals\n\nVCS docs.");
  await fsApi.writeFile(distPath, "# Build output\n\nBuild artifact.");
  await fsApi.writeFile(nestedNodeModulesPath, "# Nested deps\n\nShould not ingest.");
  await fsApi.writeFile(nestedBuildPath, "# Nested build\n\nShould not ingest.");

  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionDebounceMs: 0,
    },
    async () => rpc as never,
    console,
    fsApi as never,
  );

  await handle.start();

  assert.equal(rpc.calls.filter((call) => call.method === "ingest_markdown_document").length, 1);
  assert.equal(rpc.documents.has(keepPath), true);
  assert.equal(rpc.documents.has(nodeModulesPath), false);
  assert.equal(rpc.documents.has(gitPath), false);
  assert.equal(rpc.documents.has(distPath), false);
  assert.equal(rpc.documents.has(nestedNodeModulesPath), false);
  assert.equal(rpc.documents.has(nestedBuildPath), false);

  await handle.stop();
});
