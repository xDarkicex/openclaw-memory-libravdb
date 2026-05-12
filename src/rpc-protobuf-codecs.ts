import {
  AfterTurnKernelRequest,
  AfterTurnKernelResponse,
  AssembleContextInternalRequest,
  AssembleContextInternalResponse,
  BootstrapSessionKernelRequest,
  BootstrapSessionKernelResponse,
  CompactSessionRequest,
  CompactSessionResponse,
  DeleteAuthoredDocumentRequest,
  DeleteAuthoredDocumentResponse,
  DreamPromotionResponse,
  ExportMemoryRequest,
  ExportMemoryResponse,
  FlushNamespaceRequest,
  FlushNamespaceResponse,
  FlushResponse,
  HealthResponse,
  IngestMarkdownDocumentRequest,
  IngestMarkdownDocumentResponse,
  IngestMessageKernelRequest,
  IngestMessageKernelResponse,
  ListCollectionRequest,
  ListLifecycleJournalRequest,
  MemoryStatusResponse,
  PromoteDreamEntriesRequest,
  RankCandidatesRequest,
  RankCandidatesResponse,
  RebuildIndexRequest,
  RebuildIndexResponse,
  SearchTextCollectionsRequest,
  SearchTextRequest,
  SearchTextResponse,
  SessionLifecycleHintRequest,
  SessionLifecycleHintResponse,
  StringList,
} from "@xdarkicex/libravdb-contracts";

import type { LifecycleHint } from "./plugin-runtime.js";

export type RpcMethodCodec<Params = unknown, Result = unknown> = {
  encodeParams(params: Params): Uint8Array;
  decodeResult(bytes: Uint8Array): Result;
};

export type RpcMethodName = keyof typeof rpcProtobufCodecs;

function encodeMessage(schema: unknown, init: unknown): Uint8Array {
  return new (schema as new (init?: unknown) => { toBinary(): Uint8Array })(init as unknown).toBinary();
}

function decodeProtobufResult<T>(schema: unknown, bytes: Uint8Array): T {
  return new (schema as new () => { fromBinary(bytes: Uint8Array): { toJson(): T } })().fromBinary(bytes).toJson() as T;
}

function emptyBytes(): Uint8Array {
  return new Uint8Array(0);
}

function normalizeSearchTextResponse(bytes: Uint8Array): SearchTextResponse {
  const response = decodeProtobufResult<SearchTextResponse>(SearchTextResponse, bytes);
  if (!Array.isArray(response.results)) {
    response.results = [];
  }
  for (const item of response.results as unknown as Record<string, unknown>[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    if (!item.metadata || typeof item.metadata !== "object" || Array.isArray(item.metadata)) {
      item.metadata = {};
    }
    if (typeof item.text !== "string") {
      item.text = "";
    }
    if (typeof item.score !== "number" || !Number.isFinite(item.score)) {
      item.score = 0;
    }
  }
  return response;
}

function normalizeAssembleContextInternalResponse(
  bytes: Uint8Array,
): AssembleContextInternalResponse {
  const response = decodeProtobufResult<AssembleContextInternalResponse>(
    AssembleContextInternalResponse,
    bytes,
  );
  if (!Array.isArray(response.messages)) {
    response.messages = [];
  }
  return response;
}

function normalizeExcludeByCollection(
  value: Record<string, unknown> | undefined,
): Record<string, StringList> {
  const normalized: Record<string, StringList> = {};
  if (!value) {
    return normalized;
  }

  for (const [collection, raw] of Object.entries(value)) {
    if (raw instanceof StringList) {
      normalized[collection] = raw;
      continue;
    }

    const values = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as { values?: unknown }).values)
        ? ((raw as { values: string[] }).values)
        : [];

    normalized[collection] = new StringList({ values });
  }

  return normalized;
}

function codec<Params, Result>(
  encodeParams: (params: Params) => Uint8Array,
  decodeResult: (bytes: Uint8Array) => Result,
): RpcMethodCodec<Params, Result> {
  return { encodeParams, decodeResult };
}

const encodeEmpty = () => emptyBytes();

export const rpcProtobufCodecs = {
  health: codec<Record<string, never>, HealthResponse>(
    encodeEmpty,
    (bytes) => decodeProtobufResult<HealthResponse>(HealthResponse, bytes),
  ),
  status: codec<Record<string, never>, MemoryStatusResponse>(
    encodeEmpty,
    (bytes) => decodeProtobufResult<MemoryStatusResponse>(MemoryStatusResponse, bytes),
  ),
  flush: codec<Record<string, never>, FlushResponse>(
    encodeEmpty,
    (bytes) => decodeProtobufResult<FlushResponse>(FlushResponse, bytes),
  ),
  session_lifecycle_hint: codec<LifecycleHint, SessionLifecycleHintResponse>(
    (params) => encodeMessage(SessionLifecycleHintRequest, params),
    (bytes) => decodeProtobufResult<SessionLifecycleHintResponse>(SessionLifecycleHintResponse, bytes),
  ),
  search_text: codec<
    {
      collection: string;
      text: string;
      k?: number;
      excludeIds?: string[];
    },
    SearchTextResponse
  >(
    (params) => encodeMessage(SearchTextRequest, params),
    normalizeSearchTextResponse,
  ),
  search_text_collections: codec<
    {
      collections: string[];
      text: string;
      k?: number;
      excludeByCollection?: Record<string, unknown>;
    },
    SearchTextResponse
  >(
    (params) =>
      encodeMessage(SearchTextCollectionsRequest, {
        collections: params.collections,
        text: params.text,
        k: params.k ?? 0,
        excludeByCollection: normalizeExcludeByCollection(params.excludeByCollection),
      }),
    normalizeSearchTextResponse,
  ),
  list_collection: codec<{ collection: string }, SearchTextResponse>(
    (params) => encodeMessage(ListCollectionRequest, params),
    normalizeSearchTextResponse,
  ),
  list_lifecycle_journal: codec<
    {
      sessionId?: string;
      limit?: number;
    },
    SearchTextResponse
  >(
    (params) => encodeMessage(ListLifecycleJournalRequest, params),
    normalizeSearchTextResponse,
  ),
  export_memory: codec<
    {
      userId?: string;
      namespace?: string;
    },
    ExportMemoryResponse
  >(
    (params) => encodeMessage(ExportMemoryRequest, params),
    (bytes) => decodeProtobufResult<ExportMemoryResponse>(ExportMemoryResponse, bytes),
  ),
  flush_namespace: codec<
    {
      userId?: string;
      namespace?: string;
    },
    FlushNamespaceResponse
  >(
    (params) => encodeMessage(FlushNamespaceRequest, params),
    (bytes) => decodeProtobufResult<FlushNamespaceResponse>(FlushNamespaceResponse, bytes),
  ),
  promote_dream_entries: codec<
    {
      userId: string;
      sourceDoc: string;
      sourceRoot?: string;
      sourcePath?: string;
      sourceKind?: string;
      fileHash?: string;
      sourceSize?: number;
      sourceMtimeMs?: number;
      ingestVersion?: number;
      hashBackend?: string;
      entries?: Array<Record<string, unknown>>;
    },
    DreamPromotionResponse
  >(
    (params) => encodeMessage(PromoteDreamEntriesRequest, params),
    (bytes) => decodeProtobufResult<DreamPromotionResponse>(DreamPromotionResponse, bytes),
  ),
  ingest_markdown_document: codec<
    {
      sourceDoc: string;
      text: string;
      tokenizerId?: string;
      coreDoc?: boolean;
      sourceMeta?: Record<string, unknown>;
    },
    IngestMarkdownDocumentResponse
  >(
    (params) => encodeMessage(IngestMarkdownDocumentRequest, params),
    (bytes) => decodeProtobufResult<IngestMarkdownDocumentResponse>(IngestMarkdownDocumentResponse, bytes),
  ),
  delete_authored_document: codec<
    {
      sourceDoc: string;
    },
    DeleteAuthoredDocumentResponse
  >(
    (params) => encodeMessage(DeleteAuthoredDocumentRequest, params),
    (bytes) => decodeProtobufResult<DeleteAuthoredDocumentResponse>(DeleteAuthoredDocumentResponse, bytes),
  ),
  bootstrap_session_kernel: codec<BootstrapSessionKernelRequest, BootstrapSessionKernelResponse>(
    (params) => encodeMessage(BootstrapSessionKernelRequest, params),
    (bytes) => decodeProtobufResult<BootstrapSessionKernelResponse>(BootstrapSessionKernelResponse, bytes),
  ),
  ingest_message_kernel: codec<IngestMessageKernelRequest, IngestMessageKernelResponse>(
    (params) => encodeMessage(IngestMessageKernelRequest, params),
    (bytes) => decodeProtobufResult<IngestMessageKernelResponse>(IngestMessageKernelResponse, bytes),
  ),
  after_turn_kernel: codec<
    AfterTurnKernelRequest,
    AfterTurnKernelResponse
  >(
    (params) => encodeMessage(AfterTurnKernelRequest, params),
    (bytes) => decodeProtobufResult<AfterTurnKernelResponse>(AfterTurnKernelResponse, bytes),
  ),
  assemble_context_internal: codec<
    AssembleContextInternalRequest,
    AssembleContextInternalResponse
  >(
    (params) => encodeMessage(AssembleContextInternalRequest, params),
    normalizeAssembleContextInternalResponse,
  ),
  compact_session: codec<CompactSessionRequest, CompactSessionResponse>(
    (params) => encodeMessage(CompactSessionRequest, params),
    (bytes) => decodeProtobufResult<CompactSessionResponse>(CompactSessionResponse, bytes),
  ),
  rank_candidates: codec<RankCandidatesRequest, RankCandidatesResponse>(
    (params) => encodeMessage(RankCandidatesRequest, params),
    (bytes) => decodeProtobufResult<RankCandidatesResponse>(RankCandidatesResponse, bytes),
  ),
  rebuild_index: codec<RebuildIndexRequest, RebuildIndexResponse>(
    (params) => encodeMessage(RebuildIndexRequest, params),
    (bytes) => decodeProtobufResult<RebuildIndexResponse>(RebuildIndexResponse, bytes),
  ),
} satisfies Record<string, RpcMethodCodec<any, any>>;

export function getRpcMethodCodec(method: string): RpcMethodCodec<any, any> | undefined {
  return rpcProtobufCodecs[method as RpcMethodName];
}
