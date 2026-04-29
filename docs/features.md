# Features

This document covers optional plugin features that do not belong in the root
README: markdown ingestion, Obsidian ingestion, dream promotion, and memory CLI
commands.

## Markdown Ingestion

LibraVDB Memory can watch markdown roots and sync changed notes into vector
memory without changing the sidecar RPC contract.

The built-in source adapters are:

- `generic` for OpenClaw-owned markdown, including stock files like `MEMORY.md`
- `obsidian` for Obsidian vault roots, with tag-aware defaults

Typical usage:

- point `markdownIngestionRoots` at OpenClaw-owned markdown roots, such as
  `.openclaw/skills/*/*.md` or a directory that contains `MEMORY.md`
- enable the Obsidian adapter with `markdownIngestionObsidianEnabled: true` and
  one or more vault roots
- use include/exclude globs to narrow what gets watched

Example:

```json
{
  "plugins": {
    "configs": {
      "libravdb-memory": {
        "markdownIngestionEnabled": true,
        "markdownIngestionRoots": [
          "/Users/<you>/.openclaw/memory"
        ],
        "markdownIngestionObsidianEnabled": true,
        "markdownIngestionObsidianRoots": [
          "/Users/<you>/Documents/Obsidian/Main"
        ]
      }
    }
  }
}
```

Relevant config fields:

| Field | Purpose |
|---|---|
| `markdownIngestionEnabled` | Enables or disables generic markdown ingestion. |
| `markdownIngestionRoots` | Generic markdown roots to watch. |
| `markdownIngestionInclude` | Optional include globs for generic roots. |
| `markdownIngestionExclude` | Optional exclude globs for generic roots. |
| `markdownIngestionDebounceMs` | Watch debounce window, default `150`. |
| `markdownIngestionObsidianEnabled` | Enables Obsidian ingestion when vault roots exist. |
| `markdownIngestionObsidianRoots` | Obsidian vault roots to watch. |
| `markdownIngestionObsidianInclude` | Optional include globs for Obsidian roots. |
| `markdownIngestionObsidianExclude` | Optional exclude globs for Obsidian roots. |
| `markdownIngestionObsidianDebounceMs` | Obsidian watch debounce window, default `150`. |

By default, the Obsidian adapter auto-ingests notes that look like memory notes,
using frontmatter tags or inline tags such as `#project`. The stock OpenClaw
`MEMORY.md` file is always eligible through the generic adapter path.

## Dream Promotion

Dream promotion is an opt-in path for promoting vetted dream diary entries into
a dedicated `dream:{userId}` collection.

It does not use `MEMORY.md`. It expects a dream diary markdown file with
candidate bullets under promotion-oriented headings such as `## Deep Sleep`.
Each promoted bullet should include trailing metadata with the gating fields:

```md
- Preserve the recent tail buffer {score=0.82 recall=3 unique=2}
```

Only bullets that satisfy the sidecar gates are inserted. The dream collection
is isolated from normal `user:` and `global` retrieval by default, and dream
phrasing in chat or search queries routes there automatically.

Automatic diary watching:

```json
{
  "plugins": {
    "configs": {
      "libravdb-memory": {
        "dreamPromotionEnabled": true,
        "dreamPromotionDiaryPath": "/Users/<you>/DREAMS.md",
        "dreamPromotionUserId": "<userId>",
        "dreamPromotionDebounceMs": 150
      }
    }
  }
}
```

Manual run:

```bash
openclaw memory dream-promote --user-id <userId> --dream-file /path/to/DREAMS.md
```

The manual command and watcher both use the same sidecar promotion RPC, so
admission gates and provenance metadata are identical.

## Memory CLI

The plugin registers `openclaw memory` commands when the host exposes the plugin
CLI API.

| Command | Purpose |
|---|---|
| `openclaw memory status` | Show sidecar health, counts, active thresholds, and model readiness. |
| `openclaw memory index --force` | Refresh delegated sidecar index state for OpenClaw memory CLI compatibility. |
| `openclaw memory search "query"` | Search LibraVDB memory through the active memory runtime bridge. |
| `openclaw memory export --user-id <userId>` | Stream stored memories as newline-delimited JSON for one durable namespace. |
| `openclaw memory export --session-key <sessionKey>` | Export a namespace derived from a session key. |
| `openclaw memory flush --user-id <userId>` | Delete one durable user namespace after confirmation. |
| `openclaw memory flush --session-key <sessionKey>` | Delete a namespace derived from a session key after confirmation. |
| `openclaw memory journal --limit 50` | Inspect bounded lifecycle hints recorded by the sidecar. |
| `openclaw memory dream-promote --user-id <userId> --dream-file <path>` | Promote vetted dream diary bullets. |

Use `--yes` with `flush` only when you intentionally want to skip the
confirmation prompt.
