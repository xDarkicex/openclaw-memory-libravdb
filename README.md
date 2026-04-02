# LibraVDB Memory for OpenClaw

[![Go](https://img.shields.io/badge/Go-1.25%2B-00ADD8?logo=go&logoColor=white)](./sidecar/go.mod)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](./package.json)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-memory%20plugin-111827)](./openclaw.plugin.json)

Local-first memory for OpenClaw that pairs a TypeScript plugin with a Go
daemon, keeps recent work intact, and promotes durable memory only when the
signal is strong enough to matter.

## Install and Lifecycle

- [Install guide](./docs/install.md) for Homebrew, OpenClaw / OpenClaw.ai plugin setup, and manual daemon lifecycle.
- [Uninstall guide](./docs/uninstall.md) for clean plugin removal, daemon shutdown, and optional data cleanup.
- [Full installation reference](./docs/installation.md) for deeper operational detail, troubleshooting, and packaging notes.

Quick start on macOS:

```bash
brew tap xDarkicex/openclaw-libravdb-memory
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
    }
  }
}
```

The published plugin is connect-only. It does not compile or spawn a local Go
binary during install. The `libravdbd` daemon is managed separately and the
plugin connects to an endpoint such as `unix:$HOME/.clawdb/run/libravdb.sock`
or `tcp:127.0.0.1:37421`.

## How It Works

- [Hybrid retrieval and prompt assembly](./docs/mathematics-v2.md): combines semantic similarity, recency, memory scope, and budget-aware packing so the prompt keeps the most useful memory instead of only the nearest vectors.
- [Authored context partitioning](./docs/ast-v2.md): splits authored Markdown into hard directives, soft directives, and searchable lore so critical instructions are always preserved while narrative context still competes through retrieval.
- [Domain-Adaptive Gating](./docs/gating.md): decides which turns deserve promotion into durable memory by blending conversational and technical signals rather than treating all chats like generic prose.
- [Continuity preservation](./docs/continuity.md): protects a recent raw session tail and lets older history compact behind it, preventing summaries from erasing the newest working context.

Three practical ideas shape the runtime:

- Hybrid ranking keeps session turns, durable user memory, and global memory on the same scoreboard while still respecting recency.
- Two-pass, in-place compaction preserves continuity by refusing destructive rewrites of the newest working tail.
- Domain-adaptive ingestion avoids over-saving noisy chatter while still retaining technical decisions, file paths, error signatures, and workflow milestones.

## Runtime Model

- Plugin package: `@xdarkicex/openclaw-memory-libravdb`
- OpenClaw plugin id: `libravdb-memory`
- Minimum host version: `openclaw >= 2026.3.22`
- Default daemon endpoint on macOS/Linux: `unix:$HOME/.clawdb/run/libravdb.sock`
- Default daemon endpoint on Windows: `tcp:127.0.0.1:37421`
- Default daemon data path: `$HOME/.clawdb/data.libravdb`

## Verify

Run:

```bash
openclaw memory status
```

Expected output includes a readable status table showing whether the daemon is
reachable, how much memory is stored, and whether the local summarization path
is provisioned.
