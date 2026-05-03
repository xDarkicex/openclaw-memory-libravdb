---
name: libravdb-memory
description: LibraVDB Memory plugin hook and capability metadata.
---

# LibraVDB Memory — Hook & Capability Reference

## Lifecycle Hooks

### `before_reset`

Fires when a session is reset via `/reset` or programmatic reset.

- **Emitter:** OpenClaw core
- **Behavior:** Sends a `session_lifecycle_hint` to the sidecar with hook type
  `before_reset`, including session id, agent id, reason, message count, and
  workspace directory.
- **Side effects:** Sidecar may persist hint for journaling or eviction
  heuristics. Non-blocking.

### `session_end`

Fires when a session ends (user disconnects, session expires, or agent
completes).

- **Emitter:** OpenClaw core
- **Behavior:** Sends a `session_lifecycle_hint` with hook type `session_end`,
  including session id, agent id, message count, duration, transcript archival
  status, and next session id when applicable.
- **Side effects:** Sidecar may flush session-scoped indexes or journal the
  event. Non-blocking.

### `gateway_stop`

Fires during gateway shutdown.

- **Emitter:** OpenClaw core
- **Behavior:** Flushes pending writes to the sidecar, then shuts down the
  sidecar process and closes the gRPC kernel client (if configured).
- **Side effects:** Destructive — after this hook runs, the sidecar connection
  is closed.
- **Configuration:** None required.

## Memory Capability

Registered via `registerMemoryCapability("libravdb-memory", { ... })`.

### `promptBuilder`

Returns a static memory header block injected into the system prompt. Actual
retrieval and ranking happen in the context engine during `assemble()`.

### `runtime`

Exposes `getMemorySearchManager()` for programmatic memory search. Delegates to
the sidecar over RPC. Supports session-scoped, user-scoped, and global
collection search with hybrid scoring.

## Context Engine

Registered via `registerContextEngine("libravdb-memory", factory)`.
`ownsCompaction: true` — compaction is managed by the plugin, not the host.

### `bootstrap(args)`

Initializes a session in the vector store. Called once per session. Resolves
the durable user identity from config, auto-derived identity file, or session
key.

### `ingest(args)`

Writes a conversational message into the vector store. Called after each
assistant turn and for heartbeat messages.

### `assemble(args)`

Retrieves and assembles context for the next model call. Runs predictive
compaction when the session exceeds the configured token threshold. Augments
results with exact-match durable memory recall for fact-lookup queries.

### `compact(args)`

Runs compaction on demand. Supports force compaction and target-size-driven
compaction. Uses the kernel (gRPC) path when available, falling back to
sidecar RPC.

### `afterTurn(args)`

Post-turn hook for side effects: incremental indexing, compaction trigger
evaluation, and lifecycle journaling. Called after every agent turn including
heartbeat turns.

## CLI

### `memory`

Root command registered via `registerCli` with lazy descriptors.

Subcommands: `status`, `index`, `search`, `flush`, `export`, `journal`,
`dream-promote`.

CLI registration guards on `plugins.slots.memory === "libravdb-memory"`.
Lightweight modes register CLI structure only (no runtime, no action handlers).
