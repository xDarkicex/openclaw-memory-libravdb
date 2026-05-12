import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { LoggerLike, PluginConfig } from "./types.js";
import { hashBytes } from "./markdown-hash.js";
import { formatError } from "./format-error.js";
import { IngestQueue } from "./ingest-queue.js";

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
  snapshotPath?: string;
}

interface ScanStats {
  directoriesScanned: number;
  directoriesPruned: number;
  markdownFilesSeen: number;
  filesIncluded: number;
  filesSkipped: number;
  filesUnchanged: number;
  filesIngested: number;
  filesDeleted: number;
  syncErrors: number;
}

type SyncMarkdownResult = "ingested" | "unchanged" | "deleted" | "skipped";

interface MarkdownSnapshotFile {
  version: number;
  ingestVersion: number;
  hashBackend: string;
  files: Record<string, FileState>;
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
          snapshotPath: resolveMarkdownSnapshotPath("generic", cfg.markdownIngestionSnapshotPath),
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
          snapshotPath: resolveMarkdownSnapshotPath("obsidian", cfg.markdownIngestionObsidianSnapshotPath),
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
  private readonly snapshotPath: string;
  private readonly states = new Map<string, RootState>();
  private readonly fileStates = new Map<string, FileState>();
  private readonly activeScans = new Set<Promise<void>>();
  private readonly tokenizerId: string;
  private readonly coreDoc: boolean;
  private started = false;
  private ingestQueue: IngestQueue | null = null;
  private stopping = false;
  private snapshotLoaded = false;
  private snapshotDirty = false;

  constructor(kind: string, config: GenericMarkdownSourceConfig, getRpc: RpcGetterLike, logger: LoggerLike, fsApi: FsApi) {
    this.kind = kind;
    this.roots = config.roots;
    this.includePatterns = config.include?.length ? config.include : [];
    this.excludePatterns = config.exclude?.length ? config.exclude : [];
    this.debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.fsApi = fsApi;
    this.getRpc = getRpc;
    this.logger = logger;
    this.snapshotPath = config.snapshotPath ?? resolveMarkdownSnapshotPath(kind);
    this.tokenizerId = DEFAULT_TOKENIZER_ID;
    this.coreDoc = true;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.loadSnapshot();
    this.started = true;
    this.stopping = false;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.started || this.stopping) {
      return;
    }
    for (const root of this.roots) {
      await this.scanRoot(root);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
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
    if (this.activeScans.size > 0) {
      await Promise.allSettled([...this.activeScans]);
    }
    await this.saveSnapshotIfDirty();
    this.states.clear();
    this.fileStates.clear();
    this.snapshotLoaded = false;
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
      knownFiles: this.snapshotFilesForRoot(resolved),
      directoryWatchers: new Map<string, FsWatcherLike>(),
    };
    this.states.set(resolved, created);
    return created;
  }

  private async scanRoot(root: string): Promise<void> {
    if (!this.started || this.stopping) {
      return;
    }
    const rootState = this.getRootState(root);
    if (rootState.scanState.scanning) {
      rootState.scanState.dirty = true;
      return;
    }

    rootState.scanState.scanning = true;
    const scan = (async () => {
      const stats = createScanStats();
      const startedAt = Date.now();
      try {
        const currentFiles = new Set<string>();
        await this.walkDirectory(rootState, rootState.root, currentFiles, stats);
        if (!this.stopping) {
          await this.pruneDeletedFiles(rootState, currentFiles, stats);
          rootState.knownFiles = currentFiles;
          await this.saveSnapshotIfDirty();
          this.logScanStats(rootState.root, stats, Date.now() - startedAt);
        }
      } finally {
        rootState.scanState.scanning = false;
        if (rootState.scanState.dirty) {
          rootState.scanState.dirty = false;
          if (!this.stopping) {
            this.scheduleRootScan(rootState);
          }
        }
      }
    })();

    this.activeScans.add(scan);
    try {
      await scan;
    } finally {
      this.activeScans.delete(scan);
    }
  }

  private scheduleRootScan(rootState: RootState): void {
    if (!this.started || this.stopping) {
      return;
    }
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

  private async walkDirectory(rootState: RootState, dir: string, currentFiles: Set<string>, stats: ScanStats): Promise<void> {
    if (this.shouldPruneDirectory(rootState.root, dir)) {
      stats.directoriesPruned++;
      return;
    }

    stats.directoriesScanned++;
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
      if (this.stopping) {
        return;
      }
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walkDirectory(rootState, child, currentFiles, stats);
        continue;
      }
      if (!entry.isFile() || !isMarkdownFile(entry.name)) {
        continue;
      }
      stats.markdownFilesSeen++;
      if (!this.shouldIncludeFile(rootState.root, child)) {
        stats.filesSkipped++;
        continue;
      }
      stats.filesIncluded++;
      currentFiles.add(child);
      try {
        const result = await this.syncMarkdownFile(rootState, child);
        recordSyncResult(stats, result);
      } catch (error) {
        stats.syncErrors++;
        if (!this.stopping) {
          this.logger.warn?.(`[markdown-ingest] sync failed for ${child}: ${formatError(error)}`);
        }
      }
    }
  }

  private shouldPruneDirectory(root: string, dir: string): boolean {
    const relative = toPosixPath(path.relative(root, dir));
    if (!relative || relative === "." || relative.startsWith("..")) {
      return false;
    }
    for (const pattern of this.excludePatterns) {
      if (matchesExcludedDirectory(relative, pattern)) {
        return true;
      }
    }
    return false;
  }

  private async ensureDirectoryWatcher(rootState: RootState, dir: string): Promise<void> {
    if (rootState.directoryWatchers.has(dir)) {
      return;
    }

    try {
      const watcher = this.fsApi.watch(dir, () => {
        if (!this.stopping) {
          this.scheduleRootScan(rootState);
        }
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

  private async pruneDeletedFiles(rootState: RootState, currentFiles: Set<string>, stats: ScanStats): Promise<void> {
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
      this.snapshotDirty = true;
      stats.filesDeleted++;
    }
  }

  private async syncMarkdownFile(rootState: RootState, filePath: string): Promise<SyncMarkdownResult> {
    const sourceDoc = filePath;
    const relativePath = toPosixPath(path.relative(rootState.root, filePath));
    const stat = await this.safeStat(filePath);
    if (!stat) {
      await this.deleteSourceDocument(sourceDoc);
      this.fileStates.delete(sourceDoc);
      this.snapshotDirty = true;
      return "deleted";
    }

    const cached = this.fileStates.get(sourceDoc);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return "unchanged";
    }

    const bytes = await this.safeReadFile(filePath);
    if (!bytes) {
      await this.deleteSourceDocument(sourceDoc);
      this.fileStates.delete(sourceDoc);
      this.snapshotDirty = true;
      return "deleted";
    }

    const fileHash = hashBytes(bytes);
    if (cached && cached.fileHash === fileHash) {
      this.setFileState(sourceDoc, {
        root: rootState.root,
        sourceDoc,
        relativePath,
        fileHash,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      return "unchanged";
    }

    const text = textDecoder.decode(bytes);
    if (this.kind === "obsidian" && this.includePatterns.length === 0 && !looksLikeObsidianNote(filePath, text)) {
      await this.deleteSourceDocument(sourceDoc);
      this.fileStates.delete(sourceDoc);
      this.snapshotDirty = true;
      return "skipped";
    }
    await this.ingestMarkdownDocument(sourceDoc, text, rootState.root, relativePath, fileHash, stat.size, stat.mtimeMs);
    this.setFileState(sourceDoc, {
      root: rootState.root,
      sourceDoc,
      relativePath,
      fileHash,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
    return "ingested";
  }

  private setFileState(sourceDoc: string, state: FileState): void {
    this.fileStates.set(sourceDoc, state);
    this.snapshotDirty = true;
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
    const queue = await this.getIngestQueue();
    await queue.enqueueIngest(
      sourceDoc,
      text,
      {
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
      },
    );
  }

  private async deleteSourceDocument(sourceDoc: string): Promise<void> {
    const queue = await this.getIngestQueue();
    await queue.enqueueDelete(sourceDoc);
  }

  private async getIngestQueue(): Promise<IngestQueue> {
    if (!this.ingestQueue) {
      const rpc = await this.getRpc();
      this.ingestQueue = new IngestQueue(rpc.call.bind(rpc), this.logger);
    }
    return this.ingestQueue;
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

  private snapshotFilesForRoot(root: string): Set<string> {
    const files = new Set<string>();
    for (const state of this.fileStates.values()) {
      if (state.root === root) {
        files.add(state.sourceDoc);
      }
    }
    return files;
  }

  private async loadSnapshot(): Promise<void> {
    if (this.snapshotLoaded) {
      return;
    }
    this.snapshotLoaded = true;
    let raw: string;
    try {
      raw = await fsp.readFile(this.snapshotPath, "utf8");
    } catch (error) {
      if (!formatError(error).includes("ENOENT")) {
        this.logger.warn?.(`[markdown-ingest] failed to read snapshot ${this.snapshotPath}: ${formatError(error)}`);
      }
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<MarkdownSnapshotFile>;
      if (parsed.ingestVersion !== MARKDOWN_INGEST_VERSION || parsed.hashBackend !== HASH_BACKEND || !parsed.files) {
        return;
      }
      const configuredRoots = new Set(this.roots.map((root) => path.resolve(root)));
      for (const [sourceDoc, state] of Object.entries(parsed.files)) {
        if (isValidSnapshotState(sourceDoc, state) && configuredRoots.has(path.resolve(state.root))) {
          this.fileStates.set(sourceDoc, state);
        }
      }
      this.logger.info?.(`[markdown-ingest] loaded ${this.fileStates.size} ${this.kind} file snapshots from ${this.snapshotPath}`);
    } catch (error) {
      this.logger.warn?.(`[markdown-ingest] failed to parse snapshot ${this.snapshotPath}: ${formatError(error)}`);
    }
  }

  private async saveSnapshotIfDirty(): Promise<void> {
    if (!this.snapshotDirty) {
      return;
    }
    const payload: MarkdownSnapshotFile = {
      version: 1,
      ingestVersion: MARKDOWN_INGEST_VERSION,
      hashBackend: HASH_BACKEND,
      files: Object.fromEntries([...this.fileStates.entries()].sort(([left], [right]) => left.localeCompare(right))),
    };
    try {
      await fsp.mkdir(path.dirname(this.snapshotPath), { recursive: true });
      const tmp = `${this.snapshotPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
      await fsp.rename(tmp, this.snapshotPath);
      this.snapshotDirty = false;
    } catch (error) {
      this.logger.warn?.(`[markdown-ingest] failed to write snapshot ${this.snapshotPath}: ${formatError(error)}`);
    }
  }

  private logScanStats(root: string, stats: ScanStats, durationMs: number): void {
    this.logger.info?.(
      `[markdown-ingest] ${this.kind} scan complete root=${root} dirs=${stats.directoriesScanned} prunedDirs=${stats.directoriesPruned} markdown=${stats.markdownFilesSeen} included=${stats.filesIncluded} skipped=${stats.filesSkipped} unchanged=${stats.filesUnchanged} ingested=${stats.filesIngested} deleted=${stats.filesDeleted} errors=${stats.syncErrors} durationMs=${durationMs}`,
    );
  }
}

function createScanStats(): ScanStats {
  return {
    directoriesScanned: 0,
    directoriesPruned: 0,
    markdownFilesSeen: 0,
    filesIncluded: 0,
    filesSkipped: 0,
    filesUnchanged: 0,
    filesIngested: 0,
    filesDeleted: 0,
    syncErrors: 0,
  };
}

function recordSyncResult(stats: ScanStats, result: SyncMarkdownResult): void {
  if (result === "ingested") {
    stats.filesIngested++;
  } else if (result === "unchanged") {
    stats.filesUnchanged++;
  } else if (result === "deleted") {
    stats.filesDeleted++;
  } else {
    stats.filesSkipped++;
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

function resolveMarkdownSnapshotPath(kind: string, configuredPath?: string): string {
  const trimmed = configuredPath?.trim();
  if (trimmed) {
    return path.resolve(trimmed);
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, `libravdb-markdown-ingest-${kind}.json`);
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

function matchesExcludedDirectory(relativeDir: string, pattern: string): boolean {
  const normalized = relativeDir.replace(/\/+$/, "");
  return matchesGlob(normalized, pattern) || matchesGlob(`${normalized}/`, pattern) || matchesGlob(`${normalized}/.probe`, pattern);
}

function isValidSnapshotState(sourceDoc: string, value: unknown): value is FileState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const state = value as Partial<FileState>;
  return (
    state.sourceDoc === sourceDoc &&
    typeof state.root === "string" &&
    typeof state.relativePath === "string" &&
    typeof state.fileHash === "string" &&
    typeof state.size === "number" &&
    Number.isFinite(state.size) &&
    typeof state.mtimeMs === "number" &&
    Number.isFinite(state.mtimeMs)
  );
}

function looksLikeObsidianNote(filePath: string, text: string): boolean {
  const frontmatterStart = parseFrontmatterStart(text);
  if (frontmatterStart == null) {
    return hasInlineObsidianTag(text);
  }

  const parsed = findFrontmatterEnd(text, frontmatterStart);
  if (!parsed) {
    return hasInlineObsidianTag(text);
  }

  const frontmatter = text.slice(frontmatterStart, parsed.position);
  const lines = frontmatter.split(/\r?\n/);
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

  return hasInlineObsidianTag(text.slice(parsed.bodyOffset));
}

function parseFrontmatterStart(text: string): number | null {
  if (text.startsWith("---\n")) {
    return 4;
  }
  if (text.startsWith("---\r\n")) {
    return 5;
  }
  return null;
}

function findFrontmatterEnd(text: string, offset: number): { position: number; bodyOffset: number } | null {
  for (let i = offset; i < text.length - 3; i++) {
    if (text.charCodeAt(i) !== 45 || text.charCodeAt(i + 1) !== 45 || text.charCodeAt(i + 2) !== 45) {
      continue;
    }
    const next = text.charCodeAt(i + 3);
    if (next === 10) {
      return { position: i, bodyOffset: i + 4 };
    }
    if (next === 13 && text.charCodeAt(i + 4) === 10) {
      return { position: i, bodyOffset: i + 5 };
    }
  }
  return null;
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
    const searchable = trimmed.replace(/^#{1,6}\s+/, "");
    if (/(^|[^A-Za-z0-9_])#([A-Za-z][A-Za-z0-9/_-]*)\b/.test(searchable)) {
      return true;
    }
  }
  return false;
}

function isOpenClawMemoryFile(filePath: string): boolean {
  return path.basename(filePath).toLowerCase() === "memory.md";
}
