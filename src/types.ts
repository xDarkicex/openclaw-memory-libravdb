export interface PluginConfig {
  dbPath?: string;
  sidecarPath?: string;
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
  compactionQualityWeight?: number;
  recencyLambdaSession?: number;
  recencyLambdaUser?: number;
  recencyLambdaGlobal?: number;
  tokenBudgetFraction?: number;
  compactThreshold?: number;
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
  userHits: T[];
  globalHits: T[];
}

export interface RecallCache<T = unknown> {
  put(entry: RecallCacheEntry<T>): void;
  take(key: Pick<RecallCacheEntry<T>, "userId" | "queryText">): RecallCacheEntry<T> | undefined;
}

export interface ContextBootstrapArgs {
  sessionId: string;
  userId: string;
}

export interface ContextIngestArgs {
  sessionId: string;
  userId: string;
  message: MemoryMessage;
  isHeartbeat?: boolean;
}

export interface ContextAssembleArgs {
  sessionId: string;
  userId: string;
  messages: MemoryMessage[];
  tokenBudget: number;
}

export interface ContextCompactArgs {
  sessionId: string;
  force?: boolean;
  targetSize?: number;
}
