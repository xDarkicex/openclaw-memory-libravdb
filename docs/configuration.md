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
| `grpcEndpoint` | string | — | gRPC kernel endpoint. See `grpcEndpointTlsMode` for credential control. |
| `grpcEndpointTlsCa` | string | — | Path to CA certificate PEM file. Only needed for self-signed or private CA certs. Omit when using Let's Encrypt or cert-manager. |
| `grpcEndpointTlsMode` | string | `"auto"` | gRPC credential mode. `"auto"`: loopback/unix → plaintext, remote → TLS. `"tls"`: always TLS. `"insecure"`: always plaintext. |
| `grpcEndpointTlsClientCert` | string | — | Path to client certificate PEM for mTLS. Must be paired with `grpcEndpointTlsClientKey`. |
| `grpcEndpointTlsClientKey` | string | — | Path to client private key PEM for mTLS. Must be paired with `grpcEndpointTlsClientCert`. |
| `rpcTimeoutMs` | number | `30000` | Per-call timeout for service RPC (ms) |
| `dbPath` | string | auto-named | Explicit DB path; when set bypasses model-specific naming |

### gRPC TLS behavior

The plugin selects credentials automatically based on the endpoint:

| Endpoint format | Credential mode |
|---|---|
| `unix:/path/to/sock` | Plaintext (local) |
| `tcp:127.0.0.1:port` / `tcp:localhost:port` / `[::1]:port` | Plaintext (loopback) |
| Any other TCP or DNS target | TLS |

Use `grpcEndpointTlsMode` to override the default behavior:

| Value | When to use |
|---|---|
| `"auto"` (default) | Standard operation — plugin heuristic matches daemon TLS setting automatically. |
| `"tls"` | Daemon has TLS enabled on loopback or unix socket (rare; use when the daemon's `LIBRAVDB_GRPC_TLS_*` env vars are set on a local address). |
| `"insecure"` | Service mesh or TLS-terminating tunnel handles encryption externally; both sides are plaintext. |

**Default (local daemon):** No TLS configuration needed.
Unix socket and loopback endpoints are always plaintext regardless
of any TLS settings.

**K8 / remote daemon with CA-issued cert:**
No extra configuration needed. The plugin uses the system CA pool,
which trusts certs issued by Let's Encrypt, cert-manager, and
other public CAs automatically.

**Remote daemon with self-signed or private CA cert:**
Set `grpcEndpointTlsCa` to the path of the CA certificate PEM file:
```json
{
  "grpcEndpoint": "tcp:yourdaemon.internal:50051",
  "grpcEndpointTlsCa": "/etc/certs/ca.pem"
}
```
The daemon must be configured with matching TLS cert and key via
`LIBRAVDB_GRPC_TLS_CERT` and `LIBRAVDB_GRPC_TLS_KEY`.

**Remote daemon with mTLS (mutual TLS):**
When the daemon requires client certificate authentication, set both
`grpcEndpointTlsClientCert` and `grpcEndpointTlsClientKey` (they must both
be present or both be omitted):
```json
{
  "grpcEndpoint": "tcp:yourdaemon.internal:50051",
  "grpcEndpointTlsCa": "/etc/certs/ca.pem",
  "grpcEndpointTlsClientCert": "/etc/certs/client-cert.pem",
  "grpcEndpointTlsClientKey": "/etc/certs/client-key.pem"
}
```

**Local daemon with TLS enabled:**
If the daemon has `LIBRAVDB_GRPC_TLS_CERT`/`LIBRAVDB_GRPC_TLS_KEY` set on a loopback
address, explicitly set `grpcEndpointTlsMode: "tls"` to match:
```json
{
  "grpcEndpoint": "tcp:127.0.0.1:9090",
  "grpcEndpointTlsMode": "tls"
}
```

## Embedding

| Key | Type | Default | Notes |
|---|---|---|---|
| `embeddingProfile` | string | `nomic-embed-text-v1.5` | Primary embedding model |
| `fallbackProfile` | string | `bge-small-en-v1.5` | Fallback when primary model fails dimension checks |
| `embeddingBackend` | string | — | `bundled`, `onnx-local`, `custom-local`, or `remote` |
| `onnxDevice` | string | `auto` | ONNX execution provider: `auto`, `cpu`, `coreml` (macOS), `cuda` (Linux/Windows), `directml` (Windows), `openvino` (Linux) |
| `embeddingRuntimePath` | string | — | Path to ONNX runtime library visible to the daemon (maps to `LIBRAVDB_ONNX_RUNTIME`; required with `embeddingBackend: "onnx-local"`) |
| `embeddingModelPath` | string | — | Path to the model directory containing `embedding.json`, `model.onnx`, and `tokenizer.json` (maps to `LIBRAVDB_EMBEDDING_MODEL`; required with `embeddingBackend: "onnx-local"`) |
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
| `markdownIngestionExclude` | string[] | dependency/build dirs | Glob patterns to exclude; when empty, defaults exclude `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.cache`, `.venv`, `venv`, `__pycache__` at any depth |
| `markdownIngestionDebounceMs` | number | `150` | Debounce window for file change events |
| `markdownIngestionObsidianEnabled` | boolean | `false` | Watch Obsidian vault roots |
| `markdownIngestionObsidianRoots` | string[] | — | Obsidian vault directories |
| `markdownIngestionObsidianInclude` | string[] | — | Obsidian glob include patterns |
| `markdownIngestionObsidianExclude` | string[] | same defaults as above | Obsidian glob exclude patterns; defaults to the same set as generic markdown ingestion |
| `markdownIngestionObsidianDebounceMs` | number | `150` | Obsidian debounce window |
| `markdownIngestionSnapshotPath` | string | — | Path to snapshot file for generic markdown ingestion state |
| `markdownIngestionObsidianSnapshotPath` | string | — | Path to snapshot file for Obsidian ingestion state |

Configured markdown roots are ignored unless the matching enable flag is set to
`true`. Set `markdownIngestionEnabled: true` for generic roots and
`markdownIngestionObsidianEnabled: true` for Obsidian vault roots.

## Continuity

| Key | Type | Default | Notes |
|---|---|---|---|
| `continuityMinTurns` | number | — | Minimum conversation turns before continuity retrieval activates |
| `continuityPriorContextTokens` | number | — | Token budget allocated to prior context in continuity retrieval |
| `continuityTailBudgetTokens` | number | — | Token budget for tail-end context in continuity retrieval |

## Recovery

| Key | Type | Default | Notes |
|---|---|---|---|
| `recoveryFloorScore` | number | — | Minimum score floor for recovery-phase retrieval |
| `recoveryMinConfidenceMean` | number | — | Minimum mean confidence threshold for recovery candidates |
| `recoveryMinTopK` | number | — | Minimum number of top-K results required for recovery |

## Section 7 scoring

Two-pass retrieval scoring subsystem. These keys control the authority-weighted
and recency-adjusted scoring pass that runs after the initial vector search.

| Key | Type | Default | Notes |
|---|---|---|---|
| `section7Theta1` | number | — | Primary theta parameter for first-pass scoring |
| `section7Kappa` | number | — | Kappa scaling factor for authority scoring |
| `section7HopEta` | number | — | Eta decay for hop-distance scoring |
| `section7HopThreshold` | number | — | Hop distance threshold for second-pass eligibility |
| `section7CoarseTopK` | number | — | Top-K for coarse (first-pass) retrieval |
| `section7SecondPassTopK` | number | — | Top-K for second-pass refined retrieval |
| `section7AuthorityRecencyLambda` | number | — | Lambda for recency decay in authority scoring (commented out in code) |
| `section7AuthorityRecencyWeight` | number | — | Weight for authority recency in combined score |
| `section7AuthorityFrequencyWeight` | number | — | Weight for authority frequency in combined score |
| `section7AuthorityAuthoredWeight` | number | — | Weight for authority authored signal in combined score |
| `section7AuthoritySalienceWeight` | number | — | Weight for authority salience in combined score |
| `section7RecencyAccessLambda` | number | — | Lambda for access-based recency decay |

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
