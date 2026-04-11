import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { getHashBackendName, hashBytes } from "./markdown-hash.js";
import type { LoggerLike, PluginConfig } from "./types.js";

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_MIN_SCORE = 0.6;
const DEFAULT_MIN_RECALL_COUNT = 2;
const DEFAULT_MIN_UNIQUE_QUERIES = 2;
const DREAM_PROMOTION_VERSION = 1;
const DREAM_SOURCE_KIND = "dream";

type Disposable = { close(): void };

interface RpcLike {
  call<T>(method: string, params: unknown): Promise<T>;
}

type RpcGetterLike = () => Promise<RpcLike>;

interface FsWatcherLike extends Disposable {
  on(event: "error", handler: (error: Error) => void): void;
}

interface FsApi {
  readFile(file: string): Promise<Uint8Array>;
  stat(file: string): Promise<{ size: number; mtimeMs: number }>;
  watch(dir: string, onChange: (event: string, filename: string | Buffer | null) => void): FsWatcherLike;
}

export interface DreamPromotionHandle {
  start(): Promise<void>;
  refresh(): Promise<void>;
  stop(): Promise<void>;
}

export interface DreamPromotionCandidate {
  text: string;
  score: number;
  recallCount: number;
  uniqueQueries: number;
  section: string;
  line: number;
}

interface DreamPromotionEntry extends DreamPromotionCandidate {
  sourceLine: number;
}

interface DreamPromotionParams {
  userId: string;
  sourceDoc: string;
  sourceRoot: string;
  sourcePath: string;
  sourceKind: string;
  fileHash: string;
  sourceSize: number;
  sourceMtimeMs: number;
  ingestVersion: number;
  hashBackend: string;
  entries: DreamPromotionEntry[];
}

interface DreamPromotionResult {
  promoted?: number;
  rejected?: number;
}

interface DreamFileState {
  size: number;
  mtimeMs: number;
  fileHash: string;
}

interface DreamPromotionState {
  watching: boolean;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  watcher: FsWatcherLike | null;
}

export function createDreamPromotionHandle(
  cfg: PluginConfig,
  getRpc: RpcGetterLike,
  logger: LoggerLike = console,
  fsApi: FsApi = createRealFsApi(),
): DreamPromotionHandle {
  const diaryPath = normalizeDiaryPath(cfg.dreamPromotionDiaryPath);
  const userId = cfg.dreamPromotionUserId?.trim() ?? "";
  if (cfg.dreamPromotionEnabled !== true || !diaryPath || !userId) {
    return {
      async start() {},
      async refresh() {},
      async stop() {},
    };
  }

  const state: DreamPromotionState = {
    watching: false,
    dirty: false,
    timer: null,
    watcher: null,
  };
  let lastFileState: DreamFileState | null = null;
  const debounceMs = cfg.dreamPromotionDebounceMs ?? DEFAULT_DEBOUNCE_MS;

  return {
    async start(): Promise<void> {
      if (state.watching) {
        return;
      }
      state.watching = true;
      await refreshDiary();
    },

    async refresh(): Promise<void> {
      await refreshDiary();
    },

    async stop(): Promise<void> {
      state.watching = false;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (state.watcher) {
        state.watcher.close();
        state.watcher = null;
      }
    },
  };

  async function refreshDiary(): Promise<void> {
    if (!state.watching) {
      return;
    }
    if (state.timer) {
      state.dirty = true;
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      void scanDiary().catch((error) => {
        logger.warn?.(`[dream-promotion] refresh failed for ${diaryPath}: ${formatError(error)}`);
      });
    }, debounceMs);
  }

  async function scanDiary(): Promise<void> {
    if (!state.watching) {
      return;
    }
    await ensureWatcher();

    const stat = await safeStat(diaryPath);
    if (!stat) {
      lastFileState = null;
      return;
    }

    if (lastFileState && lastFileState.size === stat.size && lastFileState.mtimeMs === stat.mtimeMs) {
      return;
    }

    const bytes = await safeReadFile(diaryPath);
    if (!bytes) {
      lastFileState = null;
      return;
    }

    const fileHash = hashBytes(bytes);
    if (lastFileState && lastFileState.fileHash === fileHash) {
      lastFileState = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        fileHash,
      };
      return;
    }

    const text = textDecoder.decode(bytes);
    const candidates = parseDreamPromotionCandidates(text);
    if (candidates.length === 0) {
      lastFileState = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        fileHash,
      };
      return;
    }

    const rpc = await getRpc();
    const params: DreamPromotionParams = {
      userId,
      sourceDoc: diaryPath,
      sourceRoot: path.dirname(diaryPath),
      sourcePath: path.basename(diaryPath),
      sourceKind: DREAM_SOURCE_KIND,
      fileHash,
      sourceSize: stat.size,
      sourceMtimeMs: stat.mtimeMs,
      ingestVersion: DREAM_PROMOTION_VERSION,
      hashBackend: getHashBackendName(),
      entries: candidates.map((candidate, index) => ({
        ...candidate,
        sourceLine: candidate.line,
        line: index + 1,
      })),
    };
    await rpc.call<DreamPromotionResult>("promote_dream_entries", params);

    lastFileState = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      fileHash,
    };

    if (state.dirty) {
      state.dirty = false;
      await refreshDiary();
    }
  }

  async function safeStat(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      return await fsApi.stat(filePath);
    } catch {
      return null;
    }
  }

  async function safeReadFile(filePath: string): Promise<Uint8Array | null> {
    try {
      return await fsApi.readFile(filePath);
    } catch {
      return null;
    }
  }

  async function ensureWatcher(): Promise<void> {
    if (state.watcher) {
      return;
    }
    const parentDir = path.dirname(diaryPath);
    try {
      const watcher = fsApi.watch(parentDir, (_event, filename) => {
        if (filename && path.basename(String(filename)) !== path.basename(diaryPath)) {
          return;
        }
        state.dirty = true;
        void refreshDiary();
      });
      watcher.on("error", (error) => {
        logger.warn?.(`[dream-promotion] watch error for ${parentDir}: ${formatError(error)}`);
      });
      state.watcher = watcher;
    } catch (error) {
      logger.warn?.(`[dream-promotion] watch unavailable for ${parentDir}: ${formatError(error)}`);
    }
  }
}

export async function promoteDreamDiaryFile(
  rpc: RpcLike,
  opts: {
    userId: string;
    diaryPath: string;
    text?: string;
    fileHash?: string;
    sourceSize?: number;
    sourceMtimeMs?: number;
  },
): Promise<DreamPromotionResult> {
  const diaryPath = normalizeDiaryPath(opts.diaryPath);
  if (!diaryPath) {
    throw new Error("dream diary path is required");
  }
  const userId = opts.userId.trim();
  if (!userId) {
    throw new Error("user id is required");
  }

  let text = opts.text;
  let fileHash = opts.fileHash;
  let sourceSize = opts.sourceSize;
  let sourceMtimeMs = opts.sourceMtimeMs;
  if (text == null) {
    const bytes = await fsp.readFile(diaryPath);
    text = textDecoder.decode(bytes);
    fileHash = fileHash ?? hashBytes(bytes);
    const stat = await fsp.stat(diaryPath);
    sourceSize = sourceSize ?? stat.size;
    sourceMtimeMs = sourceMtimeMs ?? stat.mtimeMs;
  }

  const candidates = parseDreamPromotionCandidates(text);
  return await rpc.call<DreamPromotionResult>("promote_dream_entries", {
    userId,
    sourceDoc: diaryPath,
    sourceRoot: path.dirname(diaryPath),
    sourcePath: path.basename(diaryPath),
    sourceKind: DREAM_SOURCE_KIND,
    fileHash: fileHash ?? "",
    sourceSize: sourceSize ?? 0,
    sourceMtimeMs: sourceMtimeMs ?? 0,
    ingestVersion: DREAM_PROMOTION_VERSION,
    hashBackend: getHashBackendName(),
    entries: candidates.map((candidate, index) => ({
      ...candidate,
      sourceLine: candidate.line,
      line: index + 1,
    })),
  });
}

export function parseDreamPromotionCandidates(text: string): DreamPromotionCandidate[] {
  const candidates: DreamPromotionCandidate[] = [];
  const lines = text.split("\n");
  let inFence = false;
  let activeSection = "";

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    const heading = parseHeading(trimmed);
    if (heading) {
      activeSection = heading;
      continue;
    }

    if (!isPromotionSection(activeSection)) {
      continue;
    }

    const bullet = parseBulletCandidate(line);
    if (!bullet) {
      continue;
    }
    const metadata = parseTrailingMetadata(bullet.body);
    if (!metadata) {
      continue;
    }

    const textValue = bullet.body.slice(0, metadata.bodyStart).trim();
    if (!textValue) {
      continue;
    }

    candidates.push({
      text: textValue,
      score: metadata.score,
      recallCount: metadata.recallCount,
      uniqueQueries: metadata.uniqueQueries,
      section: activeSection,
      line: index + 1,
    });
  }

  return candidates;
}

function parseHeading(value: string): string | null {
  const match = /^(#{2,6})\s+(.+)$/.exec(value);
  if (!match) {
    return null;
  }
  return normalizeSectionName(match[2] ?? "");
}

function isPromotionSection(section: string): boolean {
  return section.includes("deep sleep") || section.includes("promot") || section.includes("dream");
}

function parseBulletCandidate(line: string): { body: string } | null {
  const match = /^\s*[-*+]\s+(.+)$/.exec(line);
  if (!match) {
    return null;
  }
  return { body: match[1] ?? "" };
}

function parseTrailingMetadata(body: string): { bodyStart: number; score: number; recallCount: number; uniqueQueries: number } | null {
  const trimmed = body.trimEnd();
  if (!trimmed.endsWith("}")) {
    return null;
  }

  const open = trimmed.lastIndexOf("{");
  if (open < 0) {
    return null;
  }

  const metadataText = trimmed.slice(open + 1, -1).trim();
  const text = trimmed.slice(0, open).trimEnd();
  if (!metadataText || !text) {
    return null;
  }

  const fields = new Map<string, string>();
  for (const token of metadataText.split(/[,\s]+/)) {
    if (!token) {
      continue;
    }
    const equals = token.indexOf("=");
    if (equals <= 0) {
      continue;
    }
    const key = token.slice(0, equals).trim().toLowerCase();
    const value = token.slice(equals + 1).trim();
    if (key && value) {
      fields.set(key, value);
    }
  }

  const score = parseNumber(fields.get("score"));
  const recallCount = parseInteger(fields.get("recall") ?? fields.get("recallcount"));
  const uniqueQueries = parseInteger(fields.get("unique") ?? fields.get("uniquequeries"));
  if (score == null || recallCount == null || uniqueQueries == null) {
    return null;
  }

  return {
    bodyStart: text.length,
    score,
    recallCount,
    uniqueQueries,
  };
}

function parseNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function parseInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function normalizeSectionName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeDiaryPath(value?: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }
  return path.resolve(trimmed);
}

function createRealFsApi(): FsApi {
  return {
    readFile: async (file: string) => fsp.readFile(file),
    stat: async (file: string) => {
      const stat = await fsp.stat(file);
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    },
    watch: (dir: string, onChange: (event: string, filename: string | Buffer | null) => void) => fs.watch(dir, onChange),
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

const textDecoder = new TextDecoder();
