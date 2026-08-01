
export interface PluginConfig {
  dbPath?: string;
  /** Legacy fallback alias for grpcEndpoint. */
  sidecarPath?: string;
  /** Stable tenant identifier for multi-agent deployments. When set, the daemon
   *  routes this plugin instance to an isolated vector database. When unset,
   *  the plugin falls back to the auto-derived userId. Set different values per
   *  agent to isolate memory storage. */
  tenantId?: string;
  /** Per-agent tenant overrides. Maps agentId → tenantId (string) or
   *  { primary: string, readAccess?: string[] } (object). Agents not listed
   *  fall through to tenantId → userId. Opt-in. */
  tenantIdByAgent?: Record<string, string | { primary: string; readAccess?: string[] }>;
  /** Maximum number of hard constraint rules. Default 20. */
  maxRules?: number;
  /** Stable identity for cross-session durable memory. When set, all sessions
   *  share memories under user:{userId}. When unset, the plugin auto-derives
   *  identity from the OS and persists it to the identity file. */
  userId?: string;
  /** Custom path to the identity JSON file. When unset the plugin resolves
   *  $OPENCLAW_STATE_DIR/libravdb-identity.json, falling back to
   *  ~/.openclaw/libravdb-identity.json. */
  identityPath?: string;
  /** When false, only session-scoped memories are retrieved. User-scoped
   *  durable recall is skipped entirely. Defaults to true. */
  crossSessionRecall?: boolean;
  useSessionRecallProjection?: boolean;
  useSessionSummarySearchExperiment?: boolean;
  /** Path to the daemon-visible ONNX Runtime library.
   * Required when embeddingBackend is "onnx-local". */
  embeddingRuntimePath?: string;
  /** Optional ONNX execution provider override passed through to libravdbd.
   *  Use "cpu" to bypass CoreML/MPS on Intel Macs or fragile GPU/NPU providers. */
  onnxDevice?: "auto" | "cpu" | "cuda" | "coreml" | "directml" | "openvino";
  embeddingBackend?: "bundled" | "onnx-local" | "gguf" | "custom-local" | "remote";
  embeddingProfile?: string;
  fallbackProfile?: string;
  /** Path to a daemon-visible model directory containing embedding.json.
   * Required when embeddingBackend is "onnx-local". */
  embeddingModelPath?: string;
  embeddingTokenizerPath?: string;
  embeddingDimensions?: number;
  embeddingNormalize?: boolean;
  /** HTTP endpoint URL for the remote embedder backend (when embeddingBackend is 'remote') */
  embeddingEndpoint?: string;
  /** Model identifier for the remote embedder backend */
  embeddingRemoteModel?: string;
  /** API key for the remote embedder endpoint */
  embeddingAPIKey?: string;
  summarizerBackend?: "bundled" | "onnx-local" | "ollama-local" | "custom-local";
  summarizerProfile?: string;
  summarizerRuntimePath?: string;
  summarizerModelPath?: string;
  summarizerTokenizerPath?: string;
  summarizerModel?: string;
  summarizerEndpoint?: string;
  sessionTTL?: number;
  topK?: number;
  alpha?: number;
  beta?: number;
  gamma?: number;
  ingestionGateThreshold?: number;
  markdownIngestionEnabled?: boolean;
  markdownIngestionRoots?: string[];
  markdownIngestionObsidianEnabled?: boolean;
  markdownIngestionObsidianRoots?: string[];
  markdownIngestionObsidianInclude?: string[];
  markdownIngestionObsidianExclude?: string[];
  markdownIngestionObsidianDebounceMs?: number;
  markdownIngestionInclude?: string[];
  markdownIngestionExclude?: string[];
  markdownIngestionDebounceMs?: number;
  markdownIngestionPriorityMode?: "mtime" | "ctime" | "size" | "fifo";
  markdownIngestionMaxTokensPerFile?: number;
  markdownIngestionSnapshotPath?: string;
  markdownIngestionObsidianSnapshotPath?: string;
  dreamPromotionEnabled?: boolean;
  dreamPromotionDiaryPath?: string;
  dreamPromotionUserId?: string;
  dreamPromotionDebounceMs?: number;
  lifecycleJournalMaxEntries?: number;
  compactionQualityWeight?: number;
  recencyLambdaSession?: number;
  recencyLambdaUser?: number;
  recencyLambdaGlobal?: number;
  tokenBudgetFraction?: number;
  /** Absolute ceiling (in tokens) on memory injection per turn, independent of
   *  the model's context window. Without it, injection is sized as
   *  tokenBudgetFraction × window, so a large-window model balloons injection.
   *  Two stages: the daemon budget is pre-capped to min(window,
   *  tokenBudgetMax / tokenBudgetFraction), then the combined systemPromptAddition
   *  is truncated to tokenBudgetMax after all injection paths land. Only the
   *  injection is bounded — the usable conversation window is untouched.
   *  Unset disables the cap. */
  tokenBudgetMax?: number;
  authoredHardBudgetFraction?: number;
  authoredSoftBudgetFraction?: number;
  elevatedGuidanceBudgetFraction?: number;
  continuityMinTurns?: number;
  continuityTailBudgetTokens?: number;
  continuityPriorContextTokens?: number;
  compactThreshold?: number;
  compactionThresholdFraction?: number;
  compactSessionTokenBudget?: number;
  /** Token budget cap for subagent memory_expand calls. Default 8000.
   *  Prevents a subagent from blowing its context window via repeated
   *  expansions. Set to 0 to disable the cap entirely. */
  subagentTokenBudget?: number;
  /** Agent ids whose sessions skip ALL LibraVDB memory/context work — no
   *  injection, ingestion, compaction, or daemon RPCs. The agent id is parsed
   *  from the session key (`agent:<agentId>:...`). Useful for latency-critical
   *  agents (e.g. a voice agent) where injected tokens and embed round-trips
   *  are pure overhead. Opt-in; empty by default. */
  excludeAgents?: string[];
  /** When true, every subagent session skips ALL LibraVDB memory/context work.
   *  Subagents are identified via the prepareSubagentSpawn lifecycle. Useful
   *  when ephemeral subagent tasks should run lean without inheriting the
   *  parent's memory injection. Opt-in; defaults to false. */
  excludeSubagents?: boolean;
  section7CoarseTopK?: number;
  section7SecondPassTopK?: number;
  section7Theta1?: number;
  section7Kappa?: number;
  section7HopEta?: number;
  section7HopThreshold?: number;
  section7AuthorityRecencyLambda?: number;
  section7AuthorityRecencyWeight?: number;
  section7AuthorityFrequencyWeight?: number;
  section7AuthorityAuthoredWeight?: number;
  section7AuthoritySalienceWeight?: number;
  section7RecencyAccessLambda?: number;
  section7AuthorityAccessWeight?: number;
  recoveryFloorScore?: number;
  recoveryMinTopK?: number;
  recoveryMinConfidenceMean?: number;
  ollamaUrl?: string;
  compactModel?: string;
  rpcTimeoutMs?: number;
  logLevel?: "debug" | "info" | "warn" | "error";
  grpcEndpoint?: string;
  grpcEndpointTlsCa?: string;  // path to CA cert PEM file for remote TLS verification
  /** Path to a client certificate PEM file for mTLS.
   * The file must contain a PEM-encoded X.509 certificate. Leaf first;
   * intermediates may follow in the same file. Required when the daemon
   * requires a client certificate (mTLS). Must be paired with
   * grpcEndpointTlsClientKey. */
  grpcEndpointTlsClientCert?: string;
  /** Path to the client private key PEM file.
   * Must correspond to the leaf certificate in grpcEndpointTlsClientCert.
   * Accepts RSA (PKCS#1/PKCS#8), ECDSA (P-256/P-384/P-521), Ed25519.
   * Required when grpcEndpointTlsClientCert is set. */
  grpcEndpointTlsClientKey?: string;
  /** Controls gRPC credential mode.
   * "auto" (default) — loopback and unix → plaintext, remote → TLS.
   * "tls"            — always use TLS regardless of address.
   * "insecure"       — always use plaintext (service mesh, tunnel). */
  grpcEndpointTlsMode?: "auto" | "tls" | "insecure";
  /** Whether BeforeTurnKernel retrieval is enabled. Default: true */
  beforeTurnEnabled?: boolean;
  /** Enable verbose BeforeTurnKernel diagnostic logging. Default: false */
  beforeTurnDebug?: boolean;
  /** Timeout in milliseconds for the BeforeTurnKernel gRPC call. Default: 5000 */
  beforeTurnTimeoutMs?: number;
  /** Timeout in milliseconds for the AssembleContextInternal gRPC call. Default: 30000 */
  assembleTimeoutMs?: number;
  /** Maximum number of retrieved memories to inject per turn. Default: 5 */
  beforeTurnMaxMemories?: number;
  /** Minimum similarity score (0.0–1.0) for semantic search hits. Default: 0.4 */
  beforeTurnMinScore?: number;
  /** Maximum size for context engine string memoization caches. Default: 1000 */
  optimizationMemoCacheSize?: number;
}

export interface SearchResult {
  id: string;
  score: number;
  text: string;
  metadata: {
    ts?: number;
    sessionId?: string;
    userId?: string;
    role?: string;
    source_doc?: string;
    node_kind?: string;
    ordinal?: number;
    position?: number;
    tier?: number;
    authored?: boolean;
    authority?: number;
    access_count?: number;
    collection?: string;
    hop_targets?: string[] | string;
    token_estimate?: number;
    continuity_tail?: boolean;
    continuity_base?: boolean;
    continuity_bundle_id?: string;
    elevated_guidance?: boolean;
    source_turn_id?: string;
    source_turn_ts?: number;
    provenance_class?: string;
    stability_weight?: number;
    expanded_from_summary?: boolean;
    parent_summary_id?: string;
    expansion_depth?: number;
    cascade_tier?: number;
    [key: string]: unknown;
  };
  finalScore?: number;
}

export interface LoggerLike {
  error(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
}

export interface PredictedContext {
  id: string;
  text: string;
  reason: string;
}

const LOG_LEVEL_RANK: Record<string, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/** Wraps a LoggerLike with logLevel filtering. Levels below configured min are dropped. */
export function levelFilteredLogger(base: LoggerLike, logLevel: PluginConfig["logLevel"]): LoggerLike {
  const minRank = LOG_LEVEL_RANK[logLevel ?? "warn"];
  return {
    error: (msg) => base.error(msg),
    warn: (msg) => { if (LOG_LEVEL_RANK.warn <= minRank) base.warn?.(msg); },
    info: (msg) => { if (LOG_LEVEL_RANK.info <= minRank) base.info?.(msg); },
  };
}
