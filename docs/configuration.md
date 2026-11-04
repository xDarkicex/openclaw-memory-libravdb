# Configuration Reference

All configuration keys are optional.

The plugin is connect-only. Configure the daemon's database, embedding backend,
model paths, and execution provider in its YAML or service environment. Plugin
model fields do not change an already-running daemon's settings. For example,
select ONNX CPU execution with `LIBRAVDB_ONNX_DEVICE=cpu` in the daemon's
environment, rather than relying on the plugin's `onnxDevice` field.

`excludeAgents: ["voice"]` disables context-engine memory work for the named
agents. It also skips their prompt routing, speaker-card and rule injection,
reset/end lifecycle hints, and memory tool factories. The native memory runtime
returns an unavailable manager before connecting for these agents. Hooks use the agent in
`sessionKey` when available, otherwise `agentId`; recently observed excluded
session IDs are retained for lifecycle events that omit both. Shared background
Markdown ingestion and diary promotion are configured separately.

## Connection

Agent operations select `tenantIdByAgent` using the host's agent ID or the agent
component of its session key. Each distinct primary tenant and read-access list
uses a separate client, so another agent's prompt hook cannot redirect queued
transcript ingestion or tools. Later callbacks that omit the session key retain
the session's explicit agent binding until runtime shutdown. Background Markdown
ingestion, dream promotion, CLI operations, and the standalone compaction provider
(whose host API supplies no agent context) use the configured default tenant.

| Key | Type | Default | Notes |
|---|---|---|---|
| `sidecarPath` | string | `auto` | `"auto"` probes standard socket paths; set `unix:/path` or `tcp:host:port` to override |
| `grpcEndpoint` | string | — | gRPC kernel endpoint. See `grpcEndpointTlsMode` for credential control. |
| `grpcEndpointTlsCa` | string | — | PEM trust anchor for a self-signed or private-CA service. cert-manager private issuers also need this; public issuers trusted by Node do not. |
| `grpcEndpointTlsMode` | string | `"auto"` | gRPC credential mode. `"auto"`: loopback/unix → plaintext, remote → TLS. `"tls"`: TCP uses TLS, including loopback. `"insecure"`: plaintext. Unix sockets always use plaintext. |
| `grpcEndpointTlsClientCert` | string | — | Path to client certificate PEM for mTLS. Must be paired with `grpcEndpointTlsClientKey`. |
| `grpcEndpointTlsClientKey` | string | — | Path to client private key PEM for mTLS. Must be paired with `grpcEndpointTlsClientCert`. |
| `rpcTimeoutMs` | number | `120000` | Per-call timeout for service RPC (ms); overrides `LIBRAVDB_RPC_TIMEOUT_MS` |
| `dbPath` | string | — | Legacy accepted field; does not change the connected daemon's database. Set `db_path` or `LIBRAVDB_DB_PATH` on the daemon. |

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
| `"auto"` (default) | Address-based selection above; the plugin does not detect the service's TLS settings. |
| `"tls"` | Daemon has TLS enabled on a loopback TCP address. Unix sockets remain plaintext. |
| `"insecure"` | Service mesh or TLS-terminating tunnel handles encryption externally; both sides are plaintext. |

**Default (local vector service):** No TLS configuration needed.
Unix sockets are always plaintext. Loopback TCP endpoints use plaintext in
`"auto"` mode and TLS when `grpcEndpointTlsMode` is `"tls"`.

**K8 / remote vector service with CA-issued cert:**
No extra plugin configuration is needed when the issuer is in Node's default
trusted roots, such as Let's Encrypt. cert-manager may use public or private
issuers; a private issuer needs `grpcEndpointTlsCa`.

**Remote vector service with self-signed or private CA cert:**
Set `grpcEndpointTlsCa` to the path of the CA certificate PEM file:
```json
{
  "grpcEndpoint": "tcp:libravdb.internal:50051",
  "grpcEndpointTlsCa": "/etc/certs/ca.pem"
}
```
The vector service must be configured with matching TLS cert and key via
`LIBRAVDB_GRPC_TLS_CERT` and `LIBRAVDB_GRPC_TLS_KEY`.

**Remote vector service with mTLS (mutual TLS):**
When the vector service requires client certificate authentication, set both
`grpcEndpointTlsClientCert` and `grpcEndpointTlsClientKey` (they must both
be present or both be omitted):
```json
{
  "grpcEndpoint": "tcp:libravdb.internal:50051",
  "grpcEndpointTlsCa": "/etc/certs/ca.pem",
  "grpcEndpointTlsClientCert": "/etc/certs/client-cert.pem",
  "grpcEndpointTlsClientKey": "/etc/certs/client-key.pem"
}
```

**Local vector service with TLS enabled:**
If the vector service has `LIBRAVDB_GRPC_TLS_CERT`/`LIBRAVDB_GRPC_TLS_KEY` set on a loopback
address, explicitly set `grpcEndpointTlsMode: "tls"` to match:
```json
{
  "grpcEndpoint": "tcp:127.0.0.1:9090",
  "grpcEndpointTlsMode": "tls"
}
```

## Embedding

These fields remain in the plugin schema for metadata and local path validation.
They are not sent as daemon configuration. `embeddingBackend: "onnx-local"`
requires runtime/model paths and validates them on the plugin host for local
endpoints; provisioning and backend selection still happen on the daemon.

| Key | Type | Default | Notes |
|---|---|---|---|
| `embeddingProfile` | string | `nomic-embed-text-v1.5` | Primary embedding model |
| `fallbackProfile` | string | `bge-small-en-v1.5` | Fallback when primary model fails dimension checks |
| `embeddingBackend` | string | — | `gguf` (recommended default), `bundled`, `onnx-local`, `custom-local`, or `remote` |
| `onnxDevice` | string | `cpu` | ONNX execution provider: `auto`, `cpu`, `coreml` (macOS), `cuda` (Linux/Windows), `directml` (Windows), `openvino` (Linux) |
| `embeddingRuntimePath` | string | — | Runtime library path used for plugin-side validation with `embeddingBackend: "onnx-local"`; configure `LIBRAVDB_ONNX_RUNTIME` separately on the daemon |
| `embeddingModelPath` | string | — | Model directory containing `embedding.json`, used for plugin-side validation with `embeddingBackend: "onnx-local"`; configure `LIBRAVDB_EMBEDDING_MODEL` separately on the daemon |
| `embeddingTokenizerPath` | string | — | Path to custom tokenizer file |
| `embeddingDimensions` | number | — | Embedding dimension override |
| `embeddingNormalize` | boolean | — | Enable embedding normalization |

## Retrieval

Recall cached for a turn is reused only while the normalized transcript through
its latest user message is unchanged. A new message identity or changed query
refreshes recall even when the transcript has the same length or query prefix.
Post-tool continuations also require the same daemon client; changing runtime or
tenant clients refreshes context instead of reusing the previous client's recall.

| Key | Type | Default | Notes |
|---|---|---|---|
| `topK` | number | — | Max results per search |
| `alpha` | number | — | Semantic similarity weight |
| `beta` | number | — | Recency weight |
| `gamma` | number | — | Summary quality weight |
| `crossSessionRecall` | boolean | `true` | When `false`, only session-scoped memories are retrieved |
| `useSessionRecallProjection` | boolean | — | Use `session_recall` collection instead of `session` |
| `useSessionSummarySearchExperiment` | boolean | — | Use `session_summary` collection for search |

## Session checkpoints

Acknowledged session transcripts are stored separately for each resolved daemon
endpoint and write tenant. Reusing a host advancement key at another destination
does not skip ingestion there. Switching back resumes that destination's checkpoint.

On upgrade, an older checkpoint without destination information is assigned to the
first destination that uses it. Start with the existing endpoint and tenant before
switching destinations, since the older file cannot identify where it was written.
This does not detect a database reset behind an unchanged endpoint and tenant.

## Ingestion gating

With `excludeSubagents: true`, a child marked by `prepareSubagentSpawn` remains
excluded across context-engine replacement and parent disposal within the same
plugin runtime. Spawn rollback, child completion, and runtime shutdown clear the
marker. Independent runtimes do not share exclusion state.

Tracked children also receive no LibraVDB tools or prompt-hook injection, and
their reset/end advisory hooks skip daemon calls. Native memory access is
blocked when the host supplies the child session key or a remembered session ID.
An agent ID alone cannot distinguish a child from its parent.

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
| `compactSessionTokenBudget` | number | `2000` | Auto-compaction token budget; `0` disables implicit predictive compaction. A positive `compactThreshold` overrides this setting; explicit host/manual compaction remains available. |
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

If OS account lookup fails, identity derivation still uses its environment fallback.
The default identity-file path falls back to the OS home-directory resolver; when
neither home lookup succeeds, derivation continues without persisting a file.
An explicit `identityPath` or `OPENCLAW_STATE_DIR` continues to take precedence.

## Markdown ingestion

Unicode characters, including emoji and supplementary CJK ideographs, are
preserved when large Markdown files are split into chunks for ingestion.

Directory watches are renewed after a root or nested directory is replaced.
A watch on the nearest existing ancestor also detects creation when a root or
its parents are initially missing, and moves closer as directories appear.
At least one ancestor must be present and watchable.

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
| `markdownIngestionSnapshotPath` | string | — | Path to snapshot file for generic markdown ingestion state; updates from concurrent root scans are serialized so restart cleanup retains every tracked document |
| `markdownIngestionObsidianSnapshotPath` | string | — | Path to snapshot file for Obsidian ingestion state |

Updates and deletes for the same source document run in order across roots and
adapters sharing a client. A replacement's APPEND chunks finish before another
replacement or deletion begins; unrelated documents can still progress in parallel.

Snapshots keep separate file checkpoints for each resolved daemon endpoint and write tenant.
Changing either destination uploads unchanged files to the new destination; returning to a
previous destination restores its cleanup history. Older snapshots are revalidated by
re-uploading present files once. This does not detect a database erased behind an unchanged
endpoint and tenant; remove the corresponding snapshot to force a full rescan in that case.

Configured markdown roots are ignored unless the matching enable flag is set to
`true`. Set `markdownIngestionEnabled: true` for generic roots and
`markdownIngestionObsidianEnabled: true` for Obsidian vault roots.

If the daemon explicitly rejects content, the scan reports an ingestion error
and leaves the file eligible for a later scan or restart. A rejected chunk is
retried at a smaller size only when none of its nodes were accepted and the
daemon supplies a lower burst limit. Already accepted chunks may remain indexed
until a successful retry replaces the document; a failed scan is not an atomic
rollback. An asynchronous acknowledgment with zero accepted and zero rejected
nodes remains a successful queue submission.

Generic and Obsidian roots may overlap within one ingestion handle. They share
the file's daemon document: removing an Obsidian tag or excluding it from one
adapter does not delete it while the other adapter still manages it. Persisted
ownership is loaded before startup pruning, and concurrent operations on the
same file are serialized. This coordination does not span independent plugin
instances or processes.

Within an adapter, an unchanged file can transfer its checkpoint to another
configured root that still accepts it. A stale scan from a different root does
not prune a document that has since been validated through its current root.

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

Diary edits received during an in-flight promotion are scanned after it finishes,
including when that promotion fails. Stopping the watcher cancels pending scans.

The diary watcher also detects creation or replacement of its containing directory,
including initially missing parent directories, provided an existing ancestor
remains watchable.

A confirmed missing dream diary reconciles that source with an empty entry list,
including when it was deleted while the plugin was offline. Permission and other
transient read errors retain existing entries. Failed reconciliation is retried on
a subsequent refresh; recreating the diary promotes its entries again.

Diary entries with malformed numeric metadata are skipped. The `recall` and
`unique` counts must fit the RPC's signed 32-bit integer fields; an out-of-range
entry is skipped so it cannot prevent valid entries in the diary from syncing.

| Key | Type | Default | Notes |
|---|---|---|---|
| `dreamPromotionEnabled` | boolean | `false` | Enable dream diary promotion |
| `dreamPromotionDiaryPath` | string | — | Path to dream diary markdown file under the operator home directory or `OPENCLAW_STATE_DIR`. Change time is checked so equal-size rewrites with preserved modification times are detected. |
| `dreamPromotionUserId` | string | — | User ID for dream collection scoping |
| `dreamPromotionDebounceMs` | number | `150` | Debounce window for dream diary changes |

If the daemon explicitly rejects ingestion nodes, promotion logs a failure and
leaves the diary fingerprint retryable on a later refresh. The `dream-promote`
CLI command exits unsuccessfully for the same response. Candidate eligibility
rejections are normal results, and asynchronous admission with zero accepted
and zero rejected nodes is also valid. A partially rejected batch is reported
as a failure without immediately replaying it.

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
