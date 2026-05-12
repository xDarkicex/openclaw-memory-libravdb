# Configuration Reference

All configuration keys are optional.

If you do not have a GPU available, setting `onnxDevice` to `"cpu"` is
recommended to avoid startup failures from missing GPU/NPU providers,
but this is also optional — the service auto-detects and falls back to
CPU when a provider is unavailable.

## Connection

| Key | Type | Default | Notes |
|---|---|---|---|
| `sidecarPath` | string | `auto` | `"auto"` probes standard socket paths; set `unix:/path` or `tcp:host:port` to override |
| `grpcEndpoint` | string | — | Optional gRPC kernel endpoint for hosts using the gRPC kernel transport |
| `rpcTimeoutMs` | number | `30000` | Per-call timeout for service RPC (ms) |
| `dbPath` | string | auto-named | Explicit DB path; when set bypasses model-specific naming |

## Embedding

| Key | Type | Default | Notes |
|---|---|---|---|
| `embeddingProfile` | string | `nomic-embed-text-v1.5` | Primary embedding model |
| `fallbackProfile` | string | `bge-small-en-v1.5` | Fallback when primary model fails dimension checks |
| `embeddingBackend` | string | — | `bundled`, `onnx-local`, or `custom-local` |
| `onnxDevice` | string | `auto` | ONNX execution provider: `auto`, `cpu`, `coreml` (macOS), `cuda` (Linux/Windows), `directml` (Windows), `openvino` (Linux) |
| `embeddingRuntimePath` | string | — | Path to ONNX runtime library (maps to `LIBRAVDB_ONNX_RUNTIME`) |
| `embeddingModelPath` | string | — | Path to custom embedding model `.onnx` file |
| `embeddingTokenizerPath` | string | — | Path to custom tokenizer file |
| `embeddingDimensions` | number | — | Embedding dimension override |
| `embeddingNormalize` | boolean | — | Enable embedding normalization |

## Retrieval

| Key | Type | Default | Notes |
|---|---|---|---|
| `topK` | number | — | Max results per search |
| `alpha` | number | — | Semantic similarity weight |
| `beta` | number | — | Recency weight |
| `gamma` | number | — | Summary quality weight |
| `crossSessionRecall` | boolean | `true` | When `false`, only session-scoped memories are retrieved |
| `useSessionRecallProjection` | boolean | — | Use `session_recall` collection instead of `session` |
| `useSessionSummarySearchExperiment` | boolean | — | Use `session_summary` collection for search |

## Ingestion gating

Gating thresholds and scoring weights are owned by the vector service and configured via
service environment variables. See the service documentation for tuning details.

The plugin exposes `ingestionGateThreshold` for host-side gating decisions:

| Key | Type | Default | Notes |
|---|---|---|---|
| `ingestionGateThreshold` | number | `0.35` | Minimum semantic relevance score used by the plugin host for ingestion gating |

## Compaction

| Key | Type | Default | Notes |
|---|---|---|---|
| `compactThreshold` | number | — | Absolute token threshold for forced compaction |
| `compactionThresholdFraction` | number | `0.8` | Dynamic trigger as fraction of active token budget |
| `compactSessionTokenBudget` | number | `2000` | Auto-compact when session exceeds this many tokens since last compaction; `0` disables |
| `compactionQualityWeight` | number | `0.5` | How much summary confidence affects retrieval score (0 = ignore, 1 = full suppression) |

## Summarizer

| Key | Type | Default | Notes |
|---|---|---|---|
| `summarizerBackend` | string | — | `bundled`, `onnx-local`, `ollama-local`, or `custom-local` |
| `summarizerProfile` | string | — | Summarizer model profile |
| `summarizerModel` | string | — | Model name for summarization |
| `summarizerModelPath` | string | — | Path to summarizer model file |
| `summarizerTokenizerPath` | string | — | Path to summarizer tokenizer file |
| `summarizerRuntimePath` | string | — | Path to summarizer ONNX runtime |
| `summarizerEndpoint` | string | — | External summarizer endpoint URL |
| `ollamaUrl` | string | — | Ollama base URL (populates `summarizerEndpoint` when unset) |
| `compactModel` | string | — | Model to use for compaction summaries (populates `summarizerModel` when unset) |

## Identity

| Key | Type | Default | Notes |
|---|---|---|---|
| `userId` | string | auto-derived | Stable user identity for cross-session durable memory |
| `identityPath` | string | `$OPENCLAW_STATE_DIR/libravdb-identity.json` | Custom path for the auto-derived identity file |

## Markdown ingestion

| Key | Type | Default | Notes |
|---|---|---|---|
| `markdownIngestionEnabled` | boolean | `false` | Watch markdown roots for changes |
| `markdownIngestionRoots` | string[] | — | Directories to watch |
| `markdownIngestionInclude` | string[] | — | Glob patterns to include |
| `markdownIngestionExclude` | string[] | — | Glob patterns to exclude |
| `markdownIngestionDebounceMs` | number | `150` | Debounce window for file change events |
| `markdownIngestionObsidianEnabled` | boolean | `false` | Watch Obsidian vault roots |
| `markdownIngestionObsidianRoots` | string[] | — | Obsidian vault directories |
| `markdownIngestionObsidianInclude` | string[] | — | Obsidian glob include patterns |
| `markdownIngestionObsidianExclude` | string[] | — | Obsidian glob exclude patterns |
| `markdownIngestionObsidianDebounceMs` | number | `150` | Obsidian debounce window |

Configured markdown roots are ignored unless the matching enable flag is set to
`true`. Set `markdownIngestionEnabled: true` for generic roots and
`markdownIngestionObsidianEnabled: true` for Obsidian vault roots.

## Dream promotion

| Key | Type | Default | Notes |
|---|---|---|---|
| `dreamPromotionEnabled` | boolean | `false` | Enable dream diary promotion |
| `dreamPromotionDiaryPath` | string | — | Path to dream diary markdown file under the operator home directory or `OPENCLAW_STATE_DIR` |
| `dreamPromotionUserId` | string | — | User ID for dream collection scoping |
| `dreamPromotionDebounceMs` | number | `150` | Debounce window for dream diary changes |

## Misc

| Key | Type | Default | Notes |
|---|---|---|---|
| `sessionTTL` | number | — | Session TTL in seconds |
| `recencyLambdaSession` | number | — | Session recency decay factor |
| `recencyLambdaUser` | number | — | User recency decay factor |
| `recencyLambdaGlobal` | number | — | Global recency decay factor |
| `tokenBudgetFraction` | number | — | Fraction of host token budget to use for memory context |
| `maxRetries` | number | — | Max RPC retries |
| `logLevel` | string | — | Log level override |
| `lifecycleJournalMaxEntries` | number | `500` | Max lifecycle journal entries |
| `authoredHardBudgetFraction` | number | — | Token budget fraction for hard-authored recall (0–1) |
| `authoredSoftBudgetFraction` | number | — | Token budget fraction for soft-authored recall (0–1) |
| `elevatedGuidanceBudgetFraction` | number | — | Token budget fraction for elevated guidance recall (0–1) |
