import type { LoggerLike } from "./types.js";
import { IngestMode } from "@xdarkicex/libravdb-contracts";

export interface IngestQueueOptions {
  /** Max tokens per chunk. Infinity = chunking disabled (retry-only mode). */
  chunkTokens: number;
  /** Base delay for exponential backoff retry in ms. */
  retryBaseDelayMs: number;
  /** Max retries per chunk. */
  maxRetries: number;
}

const DEFAULT_OPTIONS: IngestQueueOptions = {
  chunkTokens: 8192,
  retryBaseDelayMs: 500,
  maxRetries: 4,
};

interface QueuedIngest {
  sourceDoc: string;
  params: IngestMarkdownDocumentParams;
  resolve: () => void;
  reject: (err: Error) => void;
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
  mode?: IngestMode;
}

export class IngestQueue {
  private readonly queue: QueuedIngest[] = [];
  private readonly rpcCall: <T>(method: string, params: unknown) => Promise<T>;
  private readonly logger: LoggerLike;
  private readonly options: IngestQueueOptions;
  private running = false;

  constructor(
    rpcCall: <T>(method: string, params: unknown) => Promise<T>,
    logger: LoggerLike,
    options: Partial<IngestQueueOptions> = {},
  ) {
    this.rpcCall = rpcCall;
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
  ): Promise<void> {
    if (this.options.chunkTokens === Infinity) {
      // Retry-only mode: send full text as single chunk
      return this.ingestWithRetry({
        ...baseParams,
        sourceDoc,
        text,
        mode: IngestMode.REPLACE,
      });
    }

    const chunks = splitIntoChunks(text, this.options.chunkTokens);
    if (chunks.length === 1) {
      return this.ingestWithRetry({
        ...baseParams,
        sourceDoc,
        text: chunks[0].text,
        mode: IngestMode.REPLACE,
      });
    }

    // Multiple chunks: clear the source once, then append the remaining chunks.
    // Sending REPLACE last deletes the earlier chunks from the same source_doc.
    for (let i = 0; i < chunks.length; i++) {
      const isFirst = i === 0;
      const chunkParams: IngestMarkdownDocumentParams = {
        ...baseParams,
        sourceDoc,
        text: chunks[i].text,
        mode: isFirst ? IngestMode.REPLACE : IngestMode.APPEND,
      };
      await this.ingestWithRetry(chunkParams);
    }
  }

  private async ingestWithRetry(params: IngestMarkdownDocumentParams): Promise<void> {
    await withRetry(
      () => this.rpcCall("ingest_markdown_document", params) as Promise<void>,
      this.options.maxRetries,
      this.options.retryBaseDelayMs,
      this.logger,
      `ingest_markdown_document(${params.sourceDoc})`,
    );
  }

  async enqueueDelete(sourceDoc: string): Promise<void> {
    await withRetry(
      () => this.rpcCall("delete_authored_document", { sourceDoc }) as Promise<void>,
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
