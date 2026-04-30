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
backed by the `libravdbd` daemon. It replaces the lightweight default memory
path with scoped session, user, and global memory; continuity-aware prompt
assembly; durable recall; and sidecar-owned compaction.

[Install](./docs/install.md) · [Full installation reference](./docs/installation.md) · [Architecture](./docs/architecture.md) · [Security](./docs/security.md) · [Performance and tuning](./docs/performance-and-tuning.md) · [Contributing](./docs/contributing.md)

New install? Start here: [Install guide](./docs/install.md). Preferred setup on
macOS: install `libravdbd` with Homebrew, install the OpenClaw plugin, then
assign the plugin to the OpenClaw memory slot.

## Install

```bash
brew tap xDarkicex/homebrew-openclaw-libravdb-memory
brew install libravdbd
brew services start libravdbd
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

Verify the daemon and plugin:


Healthy output should show `Sidecar=running`, stored memory counts, the active
gate threshold, and the loaded embedding profile.

## Quick Start

Runtime requirements:

- OpenClaw `>= 2026.3.22`
- Node.js `>= 22`
- a separately installed `libravdbd` daemon

Compatibility note:

- this plugin is currently verified against OpenClaw `2026.4.23`

Default endpoints:

- macOS/Linux user-local daemon: `unix:$HOME/.clawdb/run/libravdb.sock`
- Homebrew daemon on Apple Silicon: `unix:/opt/homebrew/var/clawdb/run/libravdb.sock`
- Windows daemon: `tcp:127.0.0.1:37421`

If your daemon runs elsewhere, set `sidecarPath`:

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
- **Explicit daemon lifecycle** - the npm/OpenClaw package stays connect-only;
  `libravdbd` is installed and supervised separately.

## Security Defaults

Stored memory is treated as untrusted historical context. Retrieved memory is
framed before it reaches the downstream model, memory collections are scoped by
session/user/global namespace, and daemon installation is outside the npm plugin
package.

Before exposing OpenClaw over remote channels, read [Security](./docs/security.md).

## Operator Quick Refs

```bash
openclaw memory status
openclaw memory index --force
openclaw memory search "prior context"
openclaw memory export --user-id <userId>
openclaw memory flush --user-id <userId>
openclaw memory journal --limit 50
openclaw memory dream-promote --user-id <userId> --dream-file /path/to/DREAMS.md
```

Use [Install](./docs/install.md) for daemon lifecycle commands and
[Uninstall](./docs/uninstall.md) for safe shutdown and removal.

## Optional Features

- **Markdown ingestion** watches OpenClaw-owned markdown roots or Obsidian vaults
  and syncs eligible notes into memory. See [Features](./docs/features.md).
- **Dream promotion** promotes vetted dream diary bullets into an isolated
  `dream:{userId}` collection. See [Features](./docs/features.md).
- **Embedding profiles** expose local model metadata defaults for MiniLM and
  Nomic. See [Embedding profiles](./docs/embedding-profiles.md).

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
testing when you have a published daemon binary, a Homebrew daemon, or a local
daemon checkout. For the full source workflow, read [Development](./docs/development.md).

## Runtime Facts

- npm package: `@xdarkicex/openclaw-memory-libravdb`
- OpenClaw plugin id: `libravdb-memory`
- plugin kind: `memory`, `context-engine`
- minimum OpenClaw host version: `>= 2026.3.22`
- default data path: `$HOME/.clawdb/data.libravdb`
- default macOS/Linux endpoint: `unix:$HOME/.clawdb/run/libravdb.sock`
- default Windows endpoint: `tcp:127.0.0.1:37421`
