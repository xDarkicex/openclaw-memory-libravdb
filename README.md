# ♎ LibraVDB - Memory and Context Management

<div align="center">
  <img src="./docs/assets/libravdb-logo.svg" alt="LibraVDB" width="640">
</div>

<div align="center">
  <a href="https://github.com/xDarkicex/libravdbd"><img src="https://img.shields.io/badge/Go-1.25%2B-00ADD8?logo=go&logoColor=white" alt="Go 1.25+"></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5.x"></a>
  <a href="./openclaw.plugin.json"><img src="https://img.shields.io/badge/OpenClaw-memory%20plugin-111827" alt="OpenClaw memory plugin"></a>
  <a href="https://www.npmjs.com/package/@xdarkicex/openclaw-memory-libravdb"><img src="https://img.shields.io/npm/v/%40xdarkicex%2Fopenclaw-memory-libravdb?label=release&color=5B21B6" alt="Release"></a>
</div>

`@xdarkicex/openclaw-memory-libravdb` is a local-first OpenClaw memory plugin
backed by the `libravdbd` vector service. It replaces the lightweight default memory
path with scoped session, user, and global memory; continuity-aware prompt
assembly; durable recall; and sidecar-owned compaction.

[Install](./docs/install.md) · [Full installation reference](./docs/installation.md) · [Architecture](./docs/architecture.md) · [Security](./docs/security.md) · [Performance and tuning](./docs/performance-and-tuning.md) · [Contributing](./docs/contributing.md)

New install? Start here: [Install guide](./docs/install.md).

## Install

Install `libravdbd` with your system package manager, then install
the OpenClaw plugin.

**macOS (Homebrew)**

```bash
brew tap xDarkicex/homebrew-openclaw-libravdb-memory
brew install libravdbd
brew services start libravdbd
```

**Linux (APT)**

```bash
sudo apt install libravdbd
systemctl --user enable --now libravdbd
```

**Linux (AUR)**

```bash
yay -S libravdbd-bin
systemctl --user enable --now libravdbd
```

**Plugin (all platforms)**

```bash
openclaw plugins install @xdarkicex/openclaw-memory-libravdb
```

Then activate the plugin in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "libravdb-memory"
    },
    "entries": {
      "libravdb-memory": {
        "enabled": true,
        "config": {
          "sidecarPath": "auto"
        }
      }
    }
  }
}
```

Verify the service and plugin:

```bash
openclaw memory status
```

Healthy output should show `Sidecar=running`, stored memory counts, the active
gate threshold, and the loaded embedding profile.

## Quick Start

Runtime requirements:

- OpenClaw `>= 2026.3.22`
- Node.js `>= 22`
- a separately installed `libravdbd` service

Compatibility note:

- this plugin is currently verified against OpenClaw `2026.4.23`

Default endpoints:

- macOS/Linux user-local service: `unix:$HOME/.libravdbd/run/libravdb.sock`
- Homebrew service on Apple Silicon: `unix:/opt/homebrew/var/libravdbd/run/libravdb.sock`
- Windows service: `tcp:127.0.0.1:37421`

If your service runs elsewhere, set `sidecarPath`:

```json
{
  "plugins": {
    "entries": {
      "libravdb-memory": {
        "enabled": true,
        "config": {
          "sidecarPath": "tcp:127.0.0.1:37421"
        }
      }
    }
  }
}
```

## Highlights

- **Memory capability ownership** - owns the OpenClaw `memory` slot and
  registers the context engine capability at runtime.
- **Memory runtime bridge** - routes built-in `memory_search` calls to the same
  libraVDB-backed sidecar on hosts that expose the runtime API.
- **Three memory scopes** - keeps active session, durable user, and global memory
  separate.
- **Hybrid retrieval** - blends semantic similarity, scope, recency, and summary
  quality instead of relying on cosine similarity alone.
- **Continuity-aware assembly** - preserves the recent working tail while fitting
  recalled memory into a bounded prompt budget.
- **Sidecar compaction** - summarizes older session turns without flattening the
  newest working context.
- **Local-first inference** - uses local embedding and compaction paths by
  default, with optional external summarizer configuration.
- **Explicit service lifecycle** - the npm/OpenClaw package stays connect-only;
  `libravdbd` is installed and supervised separately.

## Security Defaults

Stored memory is treated as untrusted historical context. Retrieved memory is
framed before it reaches the downstream model, memory collections are scoped by
session/user/global namespace, and service installation is outside the npm plugin
package.

Before exposing OpenClaw over remote channels, read [Security](./docs/security.md).

## Operator Quick Refs

```bash
openclaw memory status [--deep] [--json]
openclaw memory index --force
openclaw memory search "prior context"
openclaw memory export --user-id <userId>
openclaw memory flush --user-id <userId>
openclaw memory journal --limit 50
openclaw memory dream-promote --user-id <userId> --dream-file /path/to/DREAMS.md
```

Use [Install](./docs/install.md) for service lifecycle commands and
[Uninstall](./docs/uninstall.md) for safe shutdown and removal.

## Configuration Reference

All configuration keys are optional.

If you do not have a GPU available, setting `onnxDevice` to `"cpu"` is
recommended to avoid startup failures from missing GPU/NPU providers,
but this is also optional — the service auto-detects and falls back to
CPU when a provider is unavailable.

### Connection

| Key | Type | Default | Notes |
|---|---|---|---|
| `sidecarPath` | string | `auto` | `"auto"` probes standard socket paths; set `unix:/path` or `tcp:host:port` to override |
| `grpcEndpoint` | string | — | Optional gRPC kernel endpoint for hosts using the gRPC kernel transport |
| `rpcTimeoutMs` | number | `30000` | Per-call timeout for service RPC (ms) |
| `dbPath` | string | auto-named | Explicit DB path; when set bypasses model-specific naming |

### Embedding

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

### Retrieval

| Key | Type | Default | Notes |
|---|---|---|---|
| `topK` | number | — | Max results per search |
| `alpha` | number | — | Semantic similarity weight |
| `beta` | number | — | Recency weight |
| `gamma` | number | — | Summary quality weight |
| `crossSessionRecall` | boolean | `true` | When `false`, only session-scoped memories are retrieved |
| `useSessionRecallProjection` | boolean | — | Use `session_recall` collection instead of `session` |
| `useSessionSummarySearchExperiment` | boolean | — | Use `session_summary` collection for search |

### Ingestion gating

| Key | Type | Default | Notes |
|---|---|---|---|
| `ingestionGateThreshold` | number | `0.35` | Minimum semantic relevance score to store a memory |
| `gatingWeights` | object | `{w1c:0.35, w2c:0.4, w3c:0.25, w1t:0.4, w2t:0.35, w3t:0.25}` | Hybrid scoring weights |
| `gatingTechNorm` | number | `1.5` | Technical content normalization factor |
| `gatingCentroidK` | number | `10` | K for centroid-based similarity gating |

### Compaction

| Key | Type | Default | Notes |
|---|---|---|---|
| `compactThreshold` | number | — | Absolute token threshold for forced compaction |
| `compactionThresholdFraction` | number | `0.8` | Dynamic trigger as fraction of active token budget |
| `compactSessionTokenBudget` | number | `2000` | Auto-compact when session exceeds this many tokens since last compaction; `0` disables |
| `compactionQualityWeight` | number | `0.5` | How much summary confidence affects retrieval score (0 = ignore, 1 = full suppression) |

### Summarizer

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

### Identity

| Key | Type | Default | Notes |
|---|---|---|---|
| `userId` | string | auto-derived | Stable user identity for cross-session durable memory |
| `identityPath` | string | `$OPENCLAW_STATE_DIR/libravdb-identity.json` | Custom path for the auto-derived identity file |

### Markdown ingestion

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

### Dream promotion

| Key | Type | Default | Notes |
|---|---|---|---|
| `dreamPromotionEnabled` | boolean | `false` | Enable dream diary promotion |
| `dreamPromotionDiaryPath` | string | — | Path to dream diary markdown file |
| `dreamPromotionUserId` | string | — | User ID for dream collection scoping |
| `dreamPromotionDebounceMs` | number | `150` | Debounce window for dream diary changes |

### Misc

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

## Optional Features

- **Markdown ingestion** watches OpenClaw-owned markdown roots or Obsidian vaults
  and syncs eligible notes into memory. See [Features](./docs/features.md).
- **Dream promotion** promotes vetted dream diary bullets into an isolated
  `dream:{userId}` collection. See [Features](./docs/features.md).
- **Embedding profiles** default to `nomic-embed-text-v1.5` with `bge-small-en-v1.5`
  fallback. See [Embedding profiles](./docs/embedding-profiles.md).

## Docs By Goal

- New install: [Install](./docs/install.md), [Installation reference](./docs/installation.md)
- Understand the design: [Problem](./docs/problem.md), [Architecture](./docs/architecture.md), [ADRs](./docs/architecture-decisions/README.md)
- Operate safely: [Security](./docs/security.md), [Uninstall](./docs/uninstall.md)
- Configure optional inputs: [Features](./docs/features.md), [Embedding profiles](./docs/embedding-profiles.md), [Models](./docs/models.md)
- Advanced operations: [Performance and tuning](./docs/performance-and-tuning.md)
- Work from source: [Development](./docs/development.md), [Contributing](./docs/contributing.md)

## From Source

```bash
pnpm install
pnpm check
bash scripts/build-daemon.sh
```

`scripts/build-daemon.sh` prepares `.daemon-bin/libravdbd` for local plugin
testing when you have a published service binary, a Homebrew service, or a local
service checkout. For the full source workflow, read [Development](./docs/development.md).

## Runtime Facts

- npm package: `@xdarkicex/openclaw-memory-libravdb`
- OpenClaw plugin id: `libravdb-memory`
- plugin kind: `memory`, `context-engine`
- minimum OpenClaw host version: `>= 2026.3.22`
- default data path: `$HOME/.libravdbd/data_nomic-embed-text-v1_5.libravdb`
- default macOS/Linux endpoint: `unix:$HOME/.libravdbd/run/libravdb.sock`
- default Windows endpoint: `tcp:127.0.0.1:37421`
