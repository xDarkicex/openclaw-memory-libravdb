import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMarkdownIngestionHandle } from "../../src/markdown-ingest.js";

class FakeRpcClient {
  calls: Array<{ method: string; params: unknown }> = [];
  documents = new Map<string, { text: string; tokenizerId: string; coreDoc: boolean; sourceMeta: Record<string, unknown> }>();

  async call<T>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, params });

    if (method === "ingest_markdown_document") {
      const { sourceDoc, text, tokenizerId, coreDoc, sourceMeta } = params as {
        sourceDoc: string;
        text: string;
        tokenizerId: string;
        coreDoc: boolean;
        sourceMeta: Record<string, unknown>;
      };
      this.documents.set(sourceDoc, { text, tokenizerId, coreDoc, sourceMeta });
      return { ok: true } as T;
    }
    if (method === "delete_authored_document") {
      const { sourceDoc } = params as { sourceDoc: string };
      this.documents.delete(sourceDoc);
      return { ok: true } as T;
    }
    if (method === "ensure_collections") {
      return { ok: true } as T;
    }

    throw new Error(`unexpected rpc call: ${method}`);
  }
}

class FakeFsApi {
  callbacks = new Map<string, Array<(event: string, filename: string | Buffer | null) => void>>();

  async readdir(dir: string) {
    return await fsp.readdir(dir, { withFileTypes: true });
  }

  async readFile(file: string) {
    return await fsp.readFile(file);
  }

  async stat(file: string) {
    const stat = await fsp.stat(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
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
    async () => rpc,
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
    async () => rpc,
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
  await fsp.mkdir(nestedDir, { recursive: true });

  await fsp.writeFile(
    filePath,
    [
      "# Policy",
      "You must keep the prompt lean.",
      "",
      "## Notes",
      "You should avoid raw blob imports.",
    ].join("\n"),
  );

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: snapshotPath(tempRoot),
    },
    async () => rpc,
    console,
    fsApi as never,
  );

  await handle.start();

  assert.equal(rpc.calls.filter((call) => call.method === "ingest_markdown_document").length, 1);
  assert.equal(rpc.documents.get(filePath)?.text.includes("keep the prompt lean"), true);
  assert.equal(rpc.documents.get(filePath)?.sourceMeta.sourceKind, "generic");

  await fsp.writeFile(
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

  await fsp.writeFile(
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

  await fsp.rm(filePath);
  fsApi.triggerAll("change");
  await delay(25);

  assert.equal(rpc.calls.filter((call) => call.method === "delete_authored_document").length, 1, "file deletion should prune authored docs");
  assert.equal(rpc.documents.has(filePath), false);

  await handle.stop();
});

test("obsidian markdown ingestion flips source kind while reusing the same rpc path", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-obsidian-"));
  const filePath = path.join(tempRoot, "memory.md");
  await fsp.writeFile(
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

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: false,
      markdownIngestionObsidianEnabled: true,
      markdownIngestionObsidianRoots: [tempRoot],
      markdownIngestionObsidianDebounceMs: 0,
      markdownIngestionObsidianSnapshotPath: snapshotPath(tempRoot, "obsidian"),
    },
    async () => rpc,
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
  await fsp.writeFile(
    filePath,
    [
      "# Scratch",
      "This note has no frontmatter tags.",
    ].join("\n"),
  );

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: false,
      markdownIngestionObsidianEnabled: true,
      markdownIngestionObsidianRoots: [tempRoot],
      markdownIngestionObsidianDebounceMs: 0,
      markdownIngestionObsidianSnapshotPath: snapshotPath(tempRoot, "obsidian"),
    },
    async () => rpc,
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
  await fsp.writeFile(
    filePath,
    [
      "# Memory",
      "This stock memory note has no tags but should still ingest.",
    ].join("\n"),
  );

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionInclude: ["skills/*/*.md"],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: snapshotPath(tempRoot),
    },
    async () => rpc,
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
  await fsp.writeFile(
    filePath,
    [
      "# Vault",
      "This note mentions #project and should ingest.",
      "```ts",
      "const example = '#ignore-me';",
      "```",
    ].join("\n"),
  );

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: false,
      markdownIngestionObsidianEnabled: true,
      markdownIngestionObsidianRoots: [tempRoot],
      markdownIngestionObsidianDebounceMs: 0,
      markdownIngestionObsidianSnapshotPath: snapshotPath(tempRoot, "obsidian"),
    },
    async () => rpc,
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
  await fsp.writeFile(
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

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: false,
      markdownIngestionObsidianEnabled: true,
      markdownIngestionObsidianRoots: [tempRoot],
      markdownIngestionObsidianDebounceMs: 0,
      markdownIngestionObsidianSnapshotPath: snapshotPath(tempRoot, "obsidian"),
    },
    async () => rpc,
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
  await fsp.writeFile(
    filePath,
    [
      "# Project #openclaw",
      "This note only has an Obsidian tag in the heading.",
    ].join("\n"),
  );

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: false,
      markdownIngestionObsidianEnabled: true,
      markdownIngestionObsidianRoots: [tempRoot],
      markdownIngestionObsidianDebounceMs: 0,
      markdownIngestionObsidianSnapshotPath: snapshotPath(tempRoot, "obsidian"),
    },
    async () => rpc,
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
    async call<T>(method: string): Promise<T> {
      assert.equal(method, "ingest_markdown_document");
      callStarted();
      await releaseCallPromise;
      rpcCompleted = true;
      return { ok: true } as T;
    },
  };

  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: snapshotPath(tempRoot),
    },
    async () => rpc,
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
  await fsp.mkdir(docsDir, { recursive: true });
  await fsp.mkdir(nodeModulesDir, { recursive: true });
  const includedPath = path.join(docsDir, "guide.md");
  const excludedPath = path.join(nodeModulesDir, "README.md");
  await fsp.writeFile(includedPath, "# Guide\n\nThis should ingest.");
  await fsp.writeFile(excludedPath, "# Package\n\nThis should not even be walked.");

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  const infoMessages: string[] = [];
  const handle = createMarkdownIngestionHandle(
    {
      markdownIngestionEnabled: true,
      markdownIngestionRoots: [tempRoot],
      markdownIngestionExclude: ["node_modules/**", "**/node_modules/**"],
      markdownIngestionDebounceMs: 0,
      markdownIngestionSnapshotPath: path.join(tempRoot, "snapshot.json"),
    },
    async () => rpc,
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
    async () => firstRpc,
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
    async () => secondRpc,
    { error() {}, warn() {}, info: (message: string) => infoMessages.push(message) },
  );

  await secondHandle.start();

  assert.equal(secondRpc.calls.filter((call) => call.method === "ingest_markdown_document").length, 0);
  assert.equal(infoMessages.some((message) => message.includes("loaded 1 generic file snapshots")), true);
  assert.equal(infoMessages.some((message) => message.includes("unchanged=1")), true);

  await secondHandle.stop();
});
