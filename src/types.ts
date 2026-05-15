
export interface PluginConfig {
  dbPath?: string;
  sidecarPath?: string;
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
  embeddingRuntimePath?: string;
  /** Optional ONNX execution provider override passed through to libravdbd.
   *  Use "cpu" to bypass CoreML/MPS on Intel Macs or fragile GPU/NPU providers. */
  onnxDevice?: "auto" | "cpu" | "cuda" | "coreml" | "directml" | "openvino";
  embeddingBackend?: "bundled" | "onnx-local" | "custom-local";
  embeddingProfile?: string;
  fallbackProfile?: string;
  embeddingModelPath?: string;
  embeddingTokenizerPath?: string;
  embeddingDimensions?: number;
  embeddingNormalize?: boolean;
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
  authoredHardBudgetFraction?: number;
  authoredSoftBudgetFraction?: number;
  elevatedGuidanceBudgetFraction?: number;
  continuityMinTurns?: number;
  continuityTailBudgetTokens?: number;
  continuityPriorContextTokens?: number;
  compactThreshold?: number;
  compactionThresholdFraction?: number;
  compactSessionTokenBudget?: number;
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
  recoveryFloorScore?: number;
  recoveryMinTopK?: number;
  recoveryMinConfidenceMean?: number;
  ollamaUrl?: string;
  compactModel?: string;
  rpcTimeoutMs?: number;
  maxRetries?: number;
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

export interface SidecarSocket {
  setEncoding(encoding: string): void;
  on(event: "data", handler: (chunk: Buffer) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  once(event: "connect", handler: () => void): void;
  once(event: "error", handler: (error: Error) => void): void;
  off(event: "connect", handler: () => void): void;
  off(event: "error", handler: (error: Error) => void): void;
  write(chunk: Buffer | string): void;
  destroy(err?: Error): void;
}

export interface LoggerLike {
  error(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
}

export interface SidecarHandle {
  socket: SidecarSocket;
  isDegraded(): boolean;
  shutdown(): Promise<void>;
}

export interface RpcCallOptions {
  timeoutMs: number;
}

export interface PredictedContext {
  id: string;
  text: string;
  reason: string;
}
