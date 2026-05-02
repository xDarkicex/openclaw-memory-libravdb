import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { LoggerLike, PluginConfig } from "./types.js";
import { hashBytes } from "./markdown-hash.js";

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_TOKENIZER_ID = "markdown-ingest:v1";
const MARKDOWN_INGEST_VERSION = 3;
const HASH_BACKEND = "wasm-fnv1a64";
type Disposable = { close(): void };

interface RpcLike {
  call<T>(method: string, params: unknown): Promise<T>;
}

type RpcGetterLike = () => Promise<RpcLike>;

interface FsDirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

interface FsWatcherLike extends Disposable {
  on(event: "error", handler: (error: Error) => void): void;
}

interface FsApi {
  readdir(dir: string): Promise<FsDirentLike[]>;
  readFile(file: string): Promise<Uint8Array>;
  stat(file: string): Promise<{ size: number; mtimeMs: number }>;
  watch(dir: string, onChange: (event: string, filename: string | Buffer | null) => void): FsWatcherLike;
}

export interface MarkdownSourceAdapter {
  kind: string;
  start(): Promise<void>;
  refresh(): Promise<void>;
  stop(): Promise<void>;
}

export interface MarkdownIngestionHandle {
  start(): Promise<void>;
  refresh(): Promise<void>;
  stop(): Promise<void>;
}

export interface MarkdownIngestionSnapshot {
  fileHash: string;
  size: number;
  mtimeMs: number;
}

interface RootState {
  root: string;
  scanState: {
    scanning: boolean;
    dirty: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  };
  knownFiles: Set<string>;
  directoryWatchers: Map<string, FsWatcherLike>;
}

interface FileState extends MarkdownIngestionSnapshot {
  root: string;
  sourceDoc: string;
  relativePath: string;
}

interface GenericMarkdownSourceConfig {
  roots: string[];
  include?: string[];
  exclude?: string[];
  debounceMs?: number;
}

interface IngestMarkdownDocumentParams {
  sourceDoc: string;
  text: string;
  tokenizerId: string;
  coreDoc: boolean;
  sourceMeta: {
    sourceRoot: string;
    sourcePath: string;
    sourceKind: string;
    fileHash: string;
    sourceSize: number;
    sourceMtimeMs: number;
    ingestVersion: number;
    hashBackend: string;
  };
}

interface DeleteAuthoredDocumentParams {
  sourceDoc: string;
}

export function createMarkdownIngestionHandle(
  cfg: PluginConfig,
  getRpc: RpcGetterLike,
  logger: LoggerLike = console,
  fsApi: FsApi = createRealFsApi(),
): MarkdownIngestionHandle {
  const adapters: MarkdownSourceAdapter[] = [];

  const genericRoots = normalizeMarkdownRoots(cfg.markdownIngestionRoots);
  if (isMarkdownIngestionEnabled(cfg, genericRoots)) {
    adapters.push(
      new DirectoryMarkdownSourceAdapter(
        "generic",
        {
          roots: genericRoots,
          include: cfg.markdownIngestionInclude,
          exclude: cfg.markdownIngestionExclude,
          debounceMs: cfg.markdownIngestionDebounceMs ?? DEFAULT_DEBOUNCE_MS,
        },
        getRpc,
        logger,
        fsApi,
      ),
    );
  }

  const obsidianRoots = normalizeMarkdownRoots(cfg.markdownIngestionObsidianRoots);
  if (cfg.markdownIngestionObsidianEnabled !== false && obsidianRoots.length > 0) {
    adapters.push(
      new DirectoryMarkdownSourceAdapter(
        "obsidian",
        {
          roots: obsidianRoots,
          include: cfg.markdownIngestionObsidianInclude,
          exclude: cfg.markdownIngestionObsidianExclude,
          debounceMs: cfg.markdownIngestionObsidianDebounceMs ?? cfg.markdownIngestionDebounceMs ?? DEFAULT_DEBOUNCE_MS,
        },
        getRpc,
        logger,
        fsApi,
      ),
    );
  }

  if (adapters.length === 0) {
    return {
      async start() {},
      async refresh() {},
      async stop() {},
    };
  }

  const adapter = new CompositeMarkdownSourceAdapter(adapters);

  return {
    start: () => adapter.start(),
    refresh: () => adapter.refresh(),
    stop: () => adapter.stop(),
  };
}

class CompositeMarkdownSourceAdapter implements MarkdownSourceAdapter {
  kind = "composite";
  constructor(private readonly adapters: MarkdownSourceAdapter[]) {}

  async start(): Promise<void> {
    for (const adapter of this.adapters) {
      await adapter.start();
    }
  }

  async refresh(): Promise<void> {
    for (const adapter of this.adapters) {
      await adapter.refresh();
    }
  }

  async stop(): Promise<void> {
    for (const adapter of this.adapters) {
      await adapter.stop();
    }
  }
}

class DirectoryMarkdownSourceAdapter implements MarkdownSourceAdapter {
  readonly kind: string;
  private readonly roots: string[];
  private readonly includePatterns: string[];
  private readonly excludePatterns: string[];
  private readonly debounceMs: number;
  private readonly fsApi: FsApi;
  private readonly getRpc: RpcGetterLike;
  private readonly logger: LoggerLike;
  private readonly states = new Map<string, RootState>();
  private readonly fileStates = new Map<string, FileState>();
  private readonly tokenizerId: string;
  private readonly coreDoc: boolean;
  private started = false;

  constructor(kind: string, config: GenericMarkdownSourceConfig, getRpc: RpcGetterLike, logger: LoggerLike, fsApi: FsApi) {
    this.kind = kind;
    this.roots = config.roots;
    this.includePatterns = config.include?.length ? config.include : [];
    this.excludePatterns = config.exclude?.length ? config.exclude : [];
    this.debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.fsApi = fsApi;
    this.getRpc = getRpc;
    this.logger = logger;
    this.tokenizerId = DEFAULT_TOKENIZER_ID;
    this.coreDoc = true;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.started) {
      return;
    }
    for (const root of this.roots) {
      await this.scanRoot(root);
    }
  }

  async stop(): Promise<void> {
    for (const state of this.states.values()) {
      if (state.scanState.timer) {
        clearTimeout(state.scanState.timer);
        state.scanState.timer = null;
      }
      for (const watcher of state.directoryWatchers.values()) {
        watcher.close();
      }
      state.directoryWatchers.clear();
    }
    this.states.clear();
    this.fileStates.clear();
    this.started = false;
  }

  private getRootState(root: string): RootState {
    const resolved = path.resolve(root);
    const existing = this.states.get(resolved);
    if (existing) {
      return existing;
    }
    const created: RootState = {
      root: resolved,
      scanState: {
        scanning: false,
        dirty: false,
        timer: null,
      },
      knownFiles: new Set<string>(),
      directoryWatchers: new Map<string, FsWatcherLike>(),
    };
    this.states.set(resolved, created);
    return created;
  }

  private async scanRoot(root: string): Promise<void> {
    const rootState = this.getRootState(root);
    if (rootState.scanState.scanning) {
      rootState.scanState.dirty = true;
      return;
    }

    rootState.scanState.scanning = true;
    try {
      const currentFiles = new Set<string>();
      await this.walkDirectory(rootState, rootState.root, currentFiles);
      await this.pruneDeletedFiles(rootState, currentFiles);
      rootState.knownFiles = currentFiles;
    } finally {
      rootState.scanState.scanning = false;
      if (rootState.scanState.dirty) {
        rootState.scanState.dirty = false;
        this.scheduleRootScan(rootState);
      }
    }
  }

  private scheduleRootScan(rootState: RootState): void {
    if (rootState.scanState.scanning) {
      rootState.scanState.dirty = true;
      return;
    }
    if (rootState.scanState.timer) {
      return;
    }
    rootState.scanState.timer = setTimeout(() => {
      rootState.scanState.timer = null;
      void this.scanRoot(rootState.root).catch((error) => {
        this.logger.warn?.(`[markdown-ingest] root scan failed for ${rootState.root}: ${formatError(error)}`);
      });
    }, this.debounceMs);
  }

  private async walkDirectory(rootState: RootState, dir: string, currentFiles: Set<string>): Promise<void> {
    await this.ensureDirectoryWatcher(rootState, dir);

    let entries: FsDirentLike[];
    try {
      entries = await this.fsApi.readdir(dir);
    } catch (error) {
      const message = formatError(error);
      if (!message.includes("ENOENT")) {
        this.logger.warn?.(`[markdown-ingest] readdir failed for ${dir}: ${message}`);
      }
      return;
    }

    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walkDirectory(rootState, child, currentFiles);
        continue;
      }
      if (!entry.isFile() || !isMarkdownFile(entry.name)) {
        continue;
      }
      if (!this.shouldIncludeFile(rootState.root, child)) {
        continue;
      }
      currentFiles.add(child);
      try {
        await this.syncMarkdownFile(rootState, child);
      } catch (error) {
        this.logger.warn?.(`[markdown-ingest] sync failed for ${child}: ${formatError(error)}`);
      }
    }
  }

  private async ensureDirectoryWatcher(rootState: RootState, dir: string): Promise<void> {
    if (rootState.directoryWatchers.has(dir)) {
      return;
    }

    try {
      const watcher = this.fsApi.watch(dir, () => {
        this.scheduleRootScan(rootState);
      });
      watcher.on("error", (error) => {
        this.logger.warn?.(`[markdown-ingest] watch error for ${dir}: ${formatError(error)}`);
      });
      rootState.directoryWatchers.set(dir, watcher);
    } catch (error) {
      this.logger.warn?.(`[markdown-ingest] watch unavailable for ${dir}: ${formatError(error)}`);
    }
  }

  private shouldIncludeFile(root: string, filePath: string): boolean {
    if (isOpenClawMemoryFile(filePath)) {
      return true;
    }
    const relative = toPosixPath(path.relative(root, filePath));
    if (this.excludePatterns.length > 0) {
      for (const pattern of this.excludePatterns) {
        if (matchesGlob(relative, pattern)) {
          return false;
        }
      }
    }
    if (this.includePatterns.length > 0) {
      for (const pattern of this.includePatterns) {
        if (matchesGlob(relative, pattern)) {
          return true;
        }
      }
      return false;
    }
    return true;
  }

  private async pruneDeletedFiles(rootState: RootState, currentFiles: Set<string>): Promise<void> {
    const removed: string[] = [];
    for (const previous of rootState.knownFiles) {
      if (!currentFiles.has(previous)) {
        removed.push(previous);
      }
    }
    if (removed.length === 0) {
      return;
    }
    for (const filePath of removed) {
      await this.deleteSourceDocument(filePath);
      this.fileStates.delete(filePath);
    }
  }

  private async syncMarkdownFile(rootState: RootState, filePath: string): Promise<void> {
    const sourceDoc = filePath;
    const relativePath = toPosixPath(path.relative(rootState.root, filePath));
    const stat = await this.safeStat(filePath);
    if (!stat) {
      await this.deleteSourceDocument(sourceDoc);
      this.fileStates.delete(sourceDoc);
      return;
    }

    const cached = this.fileStates.get(sourceDoc);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return;
    }

    const bytes = await this.safeReadFile(filePath);
    if (!bytes) {
      await this.deleteSourceDocument(sourceDoc);
      this.fileStates.delete(sourceDoc);
      return;
    }

    const fileHash = hashBytes(bytes);
    if (cached && cached.fileHash === fileHash) {
      this.fileStates.set(sourceDoc, {
        root: rootState.root,
        sourceDoc,
        relativePath,
        fileHash,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      return;
    }

    const text = textDecoder.decode(bytes);
    if (this.kind === "obsidian" && this.includePatterns.length === 0 && !looksLikeObsidianNote(filePath, text)) {
      await this.deleteSourceDocument(sourceDoc);
      this.fileStates.delete(sourceDoc);
      return;
    }
    await this.ingestMarkdownDocument(sourceDoc, text, rootState.root, relativePath, fileHash, stat.size, stat.mtimeMs);
    this.fileStates.set(sourceDoc, {
      root: rootState.root,
      sourceDoc,
      relativePath,
      fileHash,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  private async ingestMarkdownDocument(
    sourceDoc: string,
    text: string,
    sourceRoot: string,
    sourcePath: string,
    fileHash: string,
    sourceSize: number,
    sourceMtimeMs: number,
  ): Promise<void> {
    const rpc = await this.getRpc();
    const params: IngestMarkdownDocumentParams = {
      sourceDoc,
      text,
      tokenizerId: this.tokenizerId,
      coreDoc: this.coreDoc,
      sourceMeta: {
        sourceRoot,
        sourcePath,
        sourceKind: this.kind,
        fileHash,
        sourceSize,
        sourceMtimeMs: Math.trunc(sourceMtimeMs),
        ingestVersion: MARKDOWN_INGEST_VERSION,
        hashBackend: HASH_BACKEND,
      },
    };
    await rpc.call("ingest_markdown_document", params);
  }

  private async deleteSourceDocument(sourceDoc: string): Promise<void> {
    const rpc = await this.getRpc();
    const params: DeleteAuthoredDocumentParams = { sourceDoc };
    await rpc.call("delete_authored_document", params);
  }

  private async safeStat(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      return await this.fsApi.stat(filePath);
    } catch {
      return null;
    }
  }

  private async safeReadFile(filePath: string): Promise<Uint8Array | null> {
    try {
      return await this.fsApi.readFile(filePath);
    } catch {
      return null;
    }
  }
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

const textDecoder = new TextDecoder();

function normalizeMarkdownRoots(roots?: string[]): string[] {
  if (!roots?.length) {
    return [];
  }
  const resolved = new Set<string>();
  for (const root of roots) {
    const trimmed = root.trim();
    if (!trimmed) {
      continue;
    }
    resolved.add(path.resolve(trimmed));
  }
  return [...resolved];
}

function isMarkdownIngestionEnabled(cfg: PluginConfig, roots: string[]): boolean {
  if (cfg.markdownIngestionEnabled === false) {
    return false;
  }
  return roots.length > 0;
}

function createRealFsApi(): FsApi {
  return {
    readdir: async (dir: string) => fsp.readdir(dir, { withFileTypes: true }) as Promise<FsDirentLike[]>,
    readFile: async (file: string) => fsp.readFile(file),
    stat: async (file: string) => {
      const stat = await fsp.stat(file);
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    },
    watch: (dir: string, onChange: (event: string, filename: string | Buffer | null) => void) => fs.watch(dir, onChange),
  };
}

function isMarkdownFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function matchesGlob(value: string, pattern: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function looksLikeObsidianNote(filePath: string, text: string): boolean {
  if (!text.startsWith("---\n")) {
    return hasInlineObsidianTag(text);
  }

  const frontmatterEnd = findFrontmatterEnd(text, 4);
  if (frontmatterEnd < 0) {
    return hasInlineObsidianTag(text);
  }

  const frontmatter = text.slice(4, frontmatterEnd);
  const lines = frontmatter.split("\n");
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith("tags:") ||
      trimmed.startsWith("tag:") ||
      trimmed.startsWith("openclaw:") ||
      trimmed.startsWith("memory:")
    ) {
      return true;
    }
  }

  return hasInlineObsidianTag(text.slice(frontmatterEnd + 4));
}

function findFrontmatterEnd(text: string, offset: number): number {
  for (let i = offset; i < text.length - 3; i++) {
    if (text.charCodeAt(i) !== 45 || text.charCodeAt(i + 1) !== 45 || text.charCodeAt(i + 2) !== 45) {
      continue;
    }
    const next = text.charCodeAt(i + 3);
    if (next === 10) {
      return i;
    }
    if (next === 13 && text.charCodeAt(i + 4) === 10) {
      return i;
    }
  }
  return -1;
}

function hasInlineObsidianTag(text: string): boolean {
  let inFence = false;
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (trimmed.startsWith("#")) {
      continue;
    }
    if (/(^|[^A-Za-z0-9_])#([A-Za-z][A-Za-z0-9/_-]*)\b/.test(line)) {
      return true;
    }
  }
  return false;
}

function isOpenClawMemoryFile(filePath: string): boolean {
  return path.basename(filePath).toLowerCase() === "memory.md";
}
