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

Run the automated installer:

```bash
npx --yes @xdarkicex/openclaw-memory-libravdb --yes
```

The installer downloads or starts `libravdbd`, provisions ONNX Runtime and local
model assets when needed, installs the OpenClaw plugin package, writes the
current OpenClaw memory/context-engine slot config, and verifies the setup with
`openclaw memory status`.

From a source checkout, use the same installer script directly:

```bash
bash scripts/auto-install.sh --yes
```

Operator-managed installs can still install the plugin package directly:

```bash
openclaw plugins install @xdarkicex/openclaw-memory-libravdb
```

The installer writes this OpenClaw config shape:

```json
{
  "plugins": {
    "slots": {
      "memory": "libravdb-memory",
      "contextEngine": "libravdb-memory"
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
- `curl`, `jq`, and `tar` for the automated installer

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

- **Memory and context-engine ownership** - owns the OpenClaw `memory` and
  `contextEngine` slots.
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
- **Automated service lifecycle** - the installer handles daemon setup, model
  assets, OpenClaw plugin activation, and verification.

## Security Defaults

Stored memory is treated as untrusted historical context. Retrieved memory is
framed before it reaches the downstream model, memory collections are scoped by
session/user/global namespace, and service installation is performed only by the
explicit installer command.

Before exposing OpenClaw over remote channels, read [Security](./docs/security.md).

## Operator Quick Refs

```bash
openclaw memory status [--deep] [--json]
openclaw memory index --force
openclaw memory search "prior context"
openclaw memory export --user-id <userId>
openclaw memory flush --user-id <userId>
openclaw memory journal --limit 50
openclaw memory dream-promote --user-id <userId> --dream-file ~/DREAMS.md
```

Use [Install](./docs/install.md) for service lifecycle commands and
[Uninstall](./docs/uninstall.md) for safe shutdown and removal.

## Configuration

All keys are optional. For the full reference, see [Configuration](./docs/configuration.md).

| Key | Type | Default | |
|---|---|---|---|
| `sidecarPath` | string | `auto` | `"auto"` probes standard paths; set `unix:/path` or `tcp:host:port` to override |
| `embeddingProfile` | string | `nomic-embed-text-v1.5` | Primary embedding model |
| `fallbackProfile` | string | `bge-small-en-v1.5` | Fallback profile for dimension mismatches |
| `onnxDevice` | string | `auto` | ONNX execution provider; set `cpu` to bypass CoreML/MPS on Intel Macs |
| `userId` | string | auto-derived | Stable identity for cross-session durable memory |
| `crossSessionRecall` | boolean | `true` | When `false`, only session-scoped memories are retrieved |
| `compactSessionTokenBudget` | number | `2000` | Auto-compaction token threshold; `0` disables |

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
- Configure: [Configuration](./docs/configuration.md), [Features](./docs/features.md), [Embedding profiles](./docs/embedding-profiles.md), [Models](./docs/models.md)
- Operate safely: [Security](./docs/security.md), [Uninstall](./docs/uninstall.md)
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
