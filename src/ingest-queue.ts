import type { LoggerLike } from "./types.js";
import { IngestMode } from "@xdarkicex/libravdb-contracts";

export interface IngestQueueOptions {
  /** Max tokens per chunk. Infinity = chunking disabled (retry-only mode). */
  chunkTokens: number;
  /** Base delay for exponential backoff retry in ms. */
  retryBaseDelayMs: number;
  /** Max retries per chunk. */
  maxRetries: number;
  /** Called after each chunk is accepted so scan-level state stays current. */
  onChunkFeedback?: (feedback: IngestFeedback) => void;
}

const DEFAULT_OPTIONS: IngestQueueOptions = {
  chunkTokens: 8192,
  retryBaseDelayMs: 500,
  maxRetries: 4,
};

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
    sourceCtimeMs: number;
    ingestVersion: number;
    hashBackend: string;
  };
  mode?: IngestMode;
}

interface IngestFeedback {
  queueDepth: number;
  queueCapacity: number;
  acceptMore: boolean;
  retryAfterMs: number;
  processingTimeUs: number;
  nodesAccepted: number;
  nodesRejected: number;
  tokensIngested: number;
  tokenBurstLimit: number;
  walDepth?: number;
  walCapacity?: number;
}

interface IngestMarkdownDocumentResponse {
  ok: boolean;
  feedback?: IngestFeedback;
}

// Adapters sharing a client must also share document ordering, while unrelated
// clients/tenants and different documents can still make progress independently.
const documentQueues = new WeakMap<object, Map<string, Promise<void>>>();

export class IngestQueue {
  private readonly pendingByDocument: Map<string, Promise<void>>;
  private readonly ingestDocument: (params: IngestMarkdownDocumentParams) => Promise<IngestMarkdownDocumentResponse>;
  private readonly deleteDocument: (params: { sourceDoc: string }) => Promise<unknown>;
  private readonly logger: LoggerLike;
  private readonly options: IngestQueueOptions;

  constructor(
    ingestDocument: (params: IngestMarkdownDocumentParams) => Promise<IngestMarkdownDocumentResponse>,
    deleteDocument: (params: { sourceDoc: string }) => Promise<unknown>,
    logger: LoggerLike,
    options: Partial<IngestQueueOptions> = {},
    coordinationScope?: object,
  ) {
    const scope = coordinationScope ?? this;
    let pending = documentQueues.get(scope);
    if (!pending) {
      pending = new Map();
      documentQueues.set(scope, pending);
    }
    this.pendingByDocument = pending;
    this.ingestDocument = ingestDocument;
    this.deleteDocument = deleteDocument;
    this.logger = logger;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (!(this.options.chunkTokens > 0)) {
      this.logger.warn?.(`[libravdb] chunkTokens ${this.options.chunkTokens} is invalid; using default ${DEFAULT_OPTIONS.chunkTokens}`);
      this.options.chunkTokens = DEFAULT_OPTIONS.chunkTokens;
    }
  }

  async enqueueIngest(
    sourceDoc: string,
    text: string,
    baseParams: Omit<IngestMarkdownDocumentParams, "sourceDoc" | "text" | "mode">,
    maxChunkTokens?: number,
  ): Promise<IngestFeedback | undefined> {
    return await this.runDocumentOperation(sourceDoc, async () => {
      // An empty replacement must still clear the previously authored document.
      // There are no chunks to submit, so use the deletion RPC and only let the
      // caller record the empty-file snapshot after that operation succeeds.
      if (text.length === 0) {
        await this.deleteWithRetry(sourceDoc);
        return undefined;
      }
      return this.ingestChunks(sourceDoc, text, baseParams, maxChunkTokens);
    });
  }

  private async ingestChunks(
    sourceDoc: string,
    text: string,
    baseParams: Omit<IngestMarkdownDocumentParams, "sourceDoc" | "text" | "mode">,
    maxChunkTokens?: number,
  ): Promise<IngestFeedback | undefined> {
    if (this.options.chunkTokens === Infinity) {
      const resp = await this.ingestWithRetry({
        ...baseParams,
        sourceDoc,
        text,
        mode: IngestMode.REPLACE,
      });
      assertNoRejectedNodes(sourceDoc, resp.feedback, 0);
      return resp.feedback;
    }

    let currentLimit = maxChunkTokens && maxChunkTokens > 0 ? maxChunkTokens : this.options.chunkTokens;
    let offset = 0;
    let isFirst = true;
    let lastFeedback: IngestFeedback | undefined;

    while (offset < text.length) {
      const remainingText = text.slice(offset);
      const chunks = splitIntoChunks(remainingText, currentLimit);
      const chunkText = chunks[0].text;

      const chunkParams: IngestMarkdownDocumentParams = {
        ...baseParams,
        sourceDoc,
        text: chunkText,
        mode: isFirst ? IngestMode.REPLACE : IngestMode.APPEND,
      };

      const resp = await this.ingestWithRetry(chunkParams);
      lastFeedback = resp.feedback;

      // The daemon ingests asynchronously: this RPC returns at queue-time,
      // before the embed/commit runs, so nodesAccepted is normally 0 here even
      // though the chunk was successfully queued (it commits moments later).
      // Only nodesRejected > 0 signals an actual rejection. Previously this loop
      // treated nodesAccepted === 0 as a permanent rejection, which fired on
      // every async-queued chunk under load — flooding the logs with false
      // "permanently rejected" warnings even though the content committed fine.
      if (lastFeedback && lastFeedback.nodesRejected > 0) {
        // A real rejection. If the daemon reported a lower per-chunk token
        // limit, shrink and retry the same offset before giving up.
        if (lastFeedback.nodesAccepted === 0 && lastFeedback.tokenBurstLimit > 0 && lastFeedback.tokenBurstLimit < currentLimit) {
          currentLimit = lastFeedback.tokenBurstLimit;
          continue;
        }
        // Do not skip missing content or retry a partially accepted APPEND.
        // Reject so the caller cannot checkpoint the whole file as indexed.
        assertNoRejectedNodes(sourceDoc, lastFeedback, offset);
      }

      if (this.options.onChunkFeedback && lastFeedback) {
        this.options.onChunkFeedback(lastFeedback);
      }

      offset += chunkText.length;
      isFirst = false;

      if (lastFeedback && !lastFeedback.acceptMore && offset < text.length) {
        const delay = lastFeedback.retryAfterMs || 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    return lastFeedback;
  }

  private async ingestWithRetry(params: IngestMarkdownDocumentParams): Promise<IngestMarkdownDocumentResponse> {
    return withRetry(
      async () => {
        const resp = await this.ingestDocument(params);
        if (!resp.ok) {
          throw new Error(
            `ingest_markdown_document(${params.sourceDoc}) mode=${params.mode} returned ok=false`,
          );
        }
        return resp;
      },
      this.options.maxRetries,
      this.options.retryBaseDelayMs,
      this.logger,
      `ingest_markdown_document(${params.sourceDoc})`,
    );
  }

  async enqueueDelete(sourceDoc: string): Promise<void> {
    await this.runDocumentOperation(sourceDoc, () => this.deleteWithRetry(sourceDoc));
  }

  private async deleteWithRetry(sourceDoc: string): Promise<void> {
    await withRetry(
      () => this.deleteDocument({ sourceDoc }) as Promise<void>,
      this.options.maxRetries,
      this.options.retryBaseDelayMs,
      this.logger,
      `delete_authored_document(${sourceDoc})`,
    );
  }

  private runDocumentOperation<T>(sourceDoc: string, task: () => Promise<T>): Promise<T> {
    const previous = this.pendingByDocument.get(sourceDoc) ?? Promise.resolve();
    const result = previous.then(task);
    // Preserve the caller's failure, but don't poison later updates/deletes.
    const settled = result.then(() => {}, () => {});
    this.pendingByDocument.set(sourceDoc, settled);
    void settled.then(() => {
      if (this.pendingByDocument.get(sourceDoc) === settled) this.pendingByDocument.delete(sourceDoc);
    });
    return result;
  }
}

function assertNoRejectedNodes(sourceDoc: string, feedback: IngestFeedback | undefined, offset: number): void {
  if (feedback && feedback.nodesRejected > 0) {
    throw new Error(
      `[ingest-queue] Chunk rejected for ${sourceDoc} at offset=${offset} ` +
      `nodesRejected=${feedback.nodesRejected} tokenBurstLimit=${feedback.tokenBurstLimit ?? "unset"}`,
    );
  }
}

function splitIntoChunks(text: string, maxTokens: number): Array<{ text: string; ordinal: number }> {
  // Approximate: 4 chars per token for typical English text
  // Guard: zero/negative budget would make maxChars <= 0, causing an infinite
  // loop because the offset never advances past an empty slice.
  if (!(maxTokens > 0)) {
    return [{ text, ordinal: 0 }];
  }
  // A Unicode code point may need two UTF-16 code units. Even a fractional
  // caller budget must leave enough room to consume one complete code point.
  const maxChars = Math.max(2, Math.floor(maxTokens * 4));
  if (text.length <= maxChars) {
    return [{ text, ordinal: 0 }];
  }

  const chunks: Array<{ text: string; ordinal: number }> = [];
  let offset = 0;
  let ordinal = 0;

  while (offset < text.length) {
    let end = Math.min(offset + maxChars, text.length);
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      // Each chunk is encoded as a separate protobuf string. Splitting a pair
      // would turn both halves into replacement characters on the wire.
      end--;
    }

    // Walk back up to 256 chars looking for a sentence boundary.
    // `end` is exclusive, so probes must stay inside [offset, end).
    const probeLimit = Math.min(256, end - offset);
    let hardCut = end;
    for (let i = 0; i < probeLimit; i++) {
      const pos = end - 1 - i;
      if (pos <= offset) break;
      const ch = text.charAt(pos);
      if (ch === "\n" && pos + 1 < end && text.charAt(pos + 1) === "\n") {
        hardCut = pos + 2;
        break;
      }
    }
    if (hardCut === end) {
      for (let i = 0; i < probeLimit; i++) {
        const pos = end - 1 - i;
        if (pos <= offset) break;
        if (text.charAt(pos) === "\n") {
          hardCut = pos + 1;
          break;
        }
      }
    }
    if (hardCut === end) {
      for (let i = 0; i < probeLimit; i++) {
        const pos = end - 1 - i;
        if (pos <= offset) break;
        if (text.charAt(pos) === " ") {
          hardCut = pos;
          break;
        }
      }
    }

    chunks.push({ text: text.slice(offset, hardCut), ordinal });
    ordinal++;
    offset = hardCut;
  }

  return chunks;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number,
  logger: LoggerLike,
  label: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        // Full jitter: random * cap
        const cap = baseDelayMs * Math.pow(2, attempt);
        const delay = Math.random() * cap;
        logger.warn?.(`[ingest-queue] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms: ${err}`);
        await sleep(delay);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
