export interface PluginConfig {
  dbPath?: string;
  sidecarPath?: string;
  useSessionRecallProjection?: boolean;
  useSessionSummarySearchExperiment?: boolean;
  embeddingRuntimePath?: string;
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
  markdownIngestionCollection?: string;
  markdownIngestionDebounceMs?: number;
  dreamPromotionEnabled?: boolean;
  dreamPromotionDiaryPath?: string;
  dreamPromotionUserId?: string;
  dreamPromotionDebounceMs?: number;
  gatingWeights?: {
    w1c?: number;
    w2c?: number;
    w3c?: number;
    w1t?: number;
    w2t?: number;
    w3t?: number;
  };
  gatingTechNorm?: number;
  gatingCentroidK?: number;
  lifecycleJournalMaxEntries?: number;
  compactionQualityWeight?: number;
  recencyLambdaSession?: number;
  recencyLambdaUser?: number;
  recencyLambdaGlobal?: number;
  tokenBudgetFraction?: number;
  authoredHardBudgetFraction?: number;
  authoredSoftBudgetFraction?: number;
  elevatedGuidanceBudgetFraction?: number;
  section7StartupTokenBudgetTokens?: number;
  continuityMinTurns?: number;
  continuityTailBudgetTokens?: number;
  continuityPriorContextTokens?: number;
  compactThreshold?: number;
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
  summaryExpansionConfidenceThreshold?: number;
  summaryExpansionDepth?: number;
  summaryExpansionTokenBudget?: number;
  summaryExpansionPenaltyFactor?: number;
  recoveryFloorScore?: number;
  recoveryMinTopK?: number;
  recoveryMinConfidenceMean?: number;
  ollamaUrl?: string;
  compactModel?: string;
  rpcTimeoutMs?: number;
  maxRetries?: number;
  logLevel?: "debug" | "info" | "warn" | "error";
}

export interface GatingResult {
  g: number;
  t: number;
  h: number;
  r: number;
  d: number;
  p: number;
  a: number;
  dtech: number;
  gconv: number;
  gtech: number;
  inputFreq: number;
  memSaturation: number;
}

export interface MemoryMessage {
  id?: string;
  role: string;
  content: string;
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
  on(event: "data", handler: (chunk: string) => void): void;
  on(event: "close", handler: () => void): void;
  once(event: "connect", handler: () => void): void;
  once(event: "error", handler: (error: Error) => void): void;
  write(chunk: string): void;
  destroy(): void;
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

export interface RecallCacheEntry<T = unknown> {
  userId: string;
  queryText: string;
  durableVariantHits: T[];
  userHits?: T[];
  globalHits?: T[];
  authoredVariantHits?: T[];
}

export interface RecallCache<T = unknown> {
  put(entry: RecallCacheEntry<T>): void;
  get(key: Pick<RecallCacheEntry<T>, "userId" | "queryText">): RecallCacheEntry<T> | undefined;
  take(key: Pick<RecallCacheEntry<T>, "userId" | "queryText">): RecallCacheEntry<T> | undefined;
  clearUser(userId: string): void;
}

export interface ContextNamespaceArgs {
  sessionId: string;
  sessionKey?: string;
  userId?: string;
}

export interface ContextBootstrapArgs extends ContextNamespaceArgs {}

export interface ContextIngestArgs extends ContextNamespaceArgs {
  message: MemoryMessage;
  isHeartbeat?: boolean;
}

export interface ContextAssembleArgs extends ContextNamespaceArgs {
  messages: MemoryMessage[];
  tokenBudget: number;
}

export interface ContextAssembleResult {
  messages: MemoryMessage[];
  estimatedTokens: number;
  systemPromptAddition: string;
  _profile?: string[];
  _debug?: {
    recoveryTriggerFired?: boolean;
    crossSessionRawRecovery?: boolean;
    rawUserRecoveryCandidates?: Array<{
      id: string;
      text: string;
      selected: boolean;
      tokenEstimate: number;
      temporalAnchorDensity: number;
      semanticScore: number;
      slotCoverage?: number;
      slotMatches?: string[];
      lexicalCoverage: number;
      recencyScore: number;
      finalScore: number;
      rationale: string;
    }>;
    recoveryReserveTokens?: number;
    temporalQueryIndicator?: number;
    temporalQueryActive?: boolean;
    temporalQueryPatterns?: string[];
    temporalSelectorApplied?: boolean;
    temporalSelectorReason?: string;
    temporalRecoverySlots?: string[];
  };
}

export interface ContextCompactArgs {
  sessionId: string;
  force?: boolean;
  targetSize?: number;
}
