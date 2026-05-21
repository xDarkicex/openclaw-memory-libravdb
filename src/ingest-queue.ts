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

interface QueuedIngest {
  sourceDoc: string;
  params: IngestMarkdownDocumentParams;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class IngestQueue {
  private readonly queue: QueuedIngest[] = [];
  private readonly ingestDocument: (params: IngestMarkdownDocumentParams) => Promise<IngestMarkdownDocumentResponse>;
  private readonly deleteDocument: (params: { sourceDoc: string }) => Promise<unknown>;
  private readonly logger: LoggerLike;
  private readonly options: IngestQueueOptions;
  private running = false;

  constructor(
    ingestDocument: (params: IngestMarkdownDocumentParams) => Promise<IngestMarkdownDocumentResponse>,
    deleteDocument: (params: { sourceDoc: string }) => Promise<unknown>,
    logger: LoggerLike,
    options: Partial<IngestQueueOptions> = {},
  ) {
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
    if (this.options.chunkTokens === Infinity) {
      const resp = await this.ingestWithRetry({
        ...baseParams,
        sourceDoc,
        text,
        mode: IngestMode.REPLACE,
      });
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

      if (
        lastFeedback &&
        lastFeedback.nodesAccepted === 0 &&
        lastFeedback.tokenBurstLimit &&
        lastFeedback.tokenBurstLimit > 0 &&
        lastFeedback.tokenBurstLimit < currentLimit
      ) {
        currentLimit = lastFeedback.tokenBurstLimit;
        continue;
      }

      if (lastFeedback && lastFeedback.nodesAccepted === 0) {
        this.logger.warn?.(
          `[ingest-queue] Chunk permanently rejected for ${sourceDoc} ` +
          `at offset=${offset} length=${chunkText.length} ` +
          `tokenBurstLimit=${lastFeedback.tokenBurstLimit ?? "unset"}`,
        );
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
      () => this.ingestDocument(params),
      this.options.maxRetries,
      this.options.retryBaseDelayMs,
      this.logger,
      `ingest_markdown_document(${params.sourceDoc})`,
    );
  }

  async enqueueDelete(sourceDoc: string): Promise<void> {
    await withRetry(
      () => this.deleteDocument({ sourceDoc }) as Promise<void>,
      this.options.maxRetries,
      this.options.retryBaseDelayMs,
      this.logger,
      `delete_authored_document(${sourceDoc})`,
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
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) {
    return [{ text, ordinal: 0 }];
  }

  const chunks: Array<{ text: string; ordinal: number }> = [];
  let offset = 0;
  let ordinal = 0;

  while (offset < text.length) {
    let end = Math.min(offset + maxChars, text.length);

    // Walk back up to 256 chars looking for a sentence boundary
    const probeLimit = Math.min(256, end - offset);
    let hardCut = end;
    for (let i = 0; i < probeLimit; i++) {
      const pos = end - i;
      const ch = text.charAt(pos);
      if (ch === "\n" && text.charAt(pos + 1) === "\n") {
        hardCut = pos + 2;
        break;
      }
    }
    if (hardCut === end) {
      for (let i = 0; i < probeLimit; i++) {
        const pos = end - i;
        if (text.charAt(pos) === "\n") {
          hardCut = pos + 1;
          break;
        }
      }
    }
    if (hardCut === end) {
      for (let i = 0; i < probeLimit; i++) {
        const pos = end - i;
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
