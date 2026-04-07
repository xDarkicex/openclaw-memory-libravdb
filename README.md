# LibraVDB Memory for OpenClaw

[![Go](https://img.shields.io/badge/Go-1.25%2B-00ADD8?logo=go&logoColor=white)](./sidecar/go.mod)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](./package.json)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-memory%20plugin-111827)](./openclaw.plugin.json)

`@xdarkicex/openclaw-memory-libravdb` is a local-first OpenClaw memory system
for people who want more than "top-k vectors plus a prompt footer."

It replaces the default lightweight memory path with a full context lifecycle:

- active session memory
- durable per-user memory
- shared global memory
- continuity-aware compaction
- authored context partitioning
- hybrid scoring across scope, recency, and similarity

This repository pairs a TypeScript OpenClaw plugin with a Go daemon backed by
`libraVDB`. The plugin owns both the `memory` and `contextEngine` slots, while
the daemon handles embeddings, retrieval, storage, and compaction.
On newer OpenClaw builds, it also bridges the built-in `memory_search` runtime
to the same libraVDB sidecar instead of leaving that tool inert.

## Why This Exists

The stock "single memory bucket" pattern is good for simple persistence, but it
starts to break down when you care about:

- keeping the newest working context raw and intact
- separating ephemeral session state from durable memory
- avoiding long-session prompt collapse
- preserving authored instructions differently from recalled user content
- treating memory retrieval as a ranked assembly problem instead of plain
  nearest-neighbor lookup

LibraVDB Memory exists for that harder class of memory problem.

## What Makes It Different

These are the core differentiators the project is built around:

- Dual slot ownership: the plugin owns both memory prompt injection and the
  full context lifecycle.
- Built-in `memory_search` bridge: newer OpenClaw memory runtime calls are
  routed into the same sidecar-backed retrieval path.
- Lifecycle hint adoption: `before_reset` and `session_end` are used as
  advisory signals into the sidecar without giving OpenClaw control of ingest
  or compaction.
- Sidecar-owned lifecycle journal: reset/end hints are recorded internally for
  debugging and auditing without entering normal memory retrieval.
  The journal is bounded by a sidecar retention cap so it does not grow
  forever.
- Local-first runtime: the core path does not depend on external embedding
  services.
- Three-tier memory: session, durable user, and global memory stay distinct.
- Hybrid scoring: retrieval is ranked by semantic similarity, recency, scope,
  and summary quality instead of cosine alone.
- Automatic compaction: long sessions compact behind a protected recent tail.
- Crash-resilient IPC: the host talks to a sidecar over a stable local socket
  or loopback TCP endpoint with degraded-mode fallback.

## Quick Start

The supported install flow is:

```bash
brew tap xDarkicex/openclaw-libravdb-memory
brew install libravdbd
brew services start libravdbd
openclaw plugins install @xdarkicex/openclaw-memory-libravdb
```

The Homebrew formula installs the daemon plus the bundled ONNX Runtime, embedding assets, and T5 summarizer assets it needs to boot cleanly on supported platforms.

Then assign the plugin to both required OpenClaw slots in
`~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "libravdb-memory",
      "contextEngine": "libravdb-memory"
    },
    "configs": {
      "libravdb-memory": {
        "sidecarPath": "auto"
      }
    }
  }
}
```

Verify the setup:

```bash
openclaw memory status
```

Expected healthy state:

- the daemon is reachable
- the plugin is active as the memory provider
- the runtime can report stored counts and model readiness

## Install Model

This plugin is intentionally **connect-only** at install time.

It does not compile Go code during plugin installation, and it does not manage
daemon lifecycle automatically from the npm package. That is deliberate: some
OpenClaw environments are strict about postinstall behavior, daemon spawning,
and anything that looks like binary bootstrap or process management.

Current model:

- npm/OpenClaw package: plugin code and docs
- `libravdbd`: installed and managed separately
- default daemon endpoint on macOS/Linux:
  `unix:$HOME/.clawdb/run/libravdb.sock`
- default daemon endpoint on Windows:
  `tcp:127.0.0.1:37421`

If your daemon runs elsewhere, set an explicit `sidecarPath`, for example:

- `unix:/custom/path/libravdb.sock`
- `tcp:127.0.0.1:9999`

## Architecture At A Glance

```text
OpenClaw host
  -> memoryPromptSection (durable user/global recall)
  -> memory runtime bridge (built-in memory_search)
  -> context engine (bootstrap / ingest / assemble / compact)
  -> plugin runtime
  -> JSON-RPC
  -> libravdbd
  -> libraVDB + local embedding/summarization stack
```

The main runtime split is:

- TypeScript host layer:
  - OpenClaw plugin registration
  - prompt assembly
  - hybrid ranking
  - continuity-aware token budgeting
  - degraded-mode behavior
- Go daemon layer:
  - vector storage
  - embeddings
  - search RPCs
  - compaction and summarization
  - stable local IPC endpoint

For the implemented architecture map, read
[docs/architecture.md](./docs/architecture.md).

## Retrieval Model

The assembly path is not "just search some vectors and paste the top hits."

It combines:

- session search for current-work relevance
- durable user recall for long-lived personal context
- global recall for shared facts
- authored invariant and variant context
- continuity-preserving recent-tail injection
- token-budgeted fitting

The ranking model currently blends:

- semantic similarity
- scope weighting
- recency decay
- summary quality attenuation

The formal math lives in:

- [docs/mathematics-v2.md](./docs/mathematics-v2.md)
- [docs/continuity.md](./docs/continuity.md)
- [docs/ast-v2.md](./docs/ast-v2.md)
- [docs/elevated-guidance.md](./docs/elevated-guidance.md)

## LongMemEval Harness

For internal tuning, the repo includes a local LongMemEval harness that runs the
dataset through the plugin layer and measures whether the assembled prompt still
contains the evidence turns.

The benchmark runner is committed, but the dataset and generated reports are not.
Keep downloaded data and local outputs under `benchmarks/longmemeval/`, which is
ignored by default.

The harness writes JSONL incrementally, so partial results survive if a transient
daemon failure interrupts a long run.

The run summary now prints a compact table with total questions, processed rows,
skipped abstentions, errors, session hit rate, turn hit rate, and average prompt
size.

Run it with:

```bash
LONGMEMEVAL_DATA_FILE=/path/to/longmemeval_oracle.json pnpm run benchmark:longmemeval
```

If you already have a daemon running and do not want the benchmark to spawn
another one, set:

```bash
LONGMEMEVAL_USE_EXISTING_DAEMON=1 LONGMEMEVAL_SIDECAR_PATH=unix:/path/to/libravdb.sock
```

If the local test daemon drops mid-run, the benchmark will restart it and retry
the current instance once before recording an error result.

Optional outputs:

- `LONGMEMEVAL_LIMIT` to cap the number of questions
- `LONGMEMEVAL_TOPK` to change the search budget
- `LONGMEMEVAL_OUT_FILE` to write JSONL records for analysis

To score a hypothesis JSONL file with the official LongMemEval evaluator, point
the repo at a local checkout of the benchmark and run:

```bash
LONGMEMEVAL_EVAL_REPO=/path/to/LongMemEval \
LONGMEMEVAL_HYPOTHESIS_FILE=/path/to/hypotheses.jsonl \
LONGMEMEVAL_DATA_FILE=/path/to/longmemeval_oracle.json \
OPENAI_API_KEY=... \
pnpm run benchmark:longmemeval:score
```

That scorer wrapper shells out to the official Python evaluation script and then
prints the aggregate metrics from the generated log when available.

## Compaction Model

This system does not treat long chats as append-only forever.

Older session turns compact behind a protected recent tail, so the plugin can:

- keep the newest working context raw
- preserve adjacency-sensitive continuity near the boundary
- promote older material into summaries
- avoid letting long sessions drown their own prompt budget

Compaction is designed as part of the memory system itself, not as a separate
maintenance convenience.

## For Power Users

If you are evaluating this as an operator or advanced OpenClaw user, the key
practical points are:

- This plugin should own both `memory` and `contextEngine`. Partial slot
  assignment is a misconfiguration.
- On hosts that expose `registerMemoryRuntime`, the built-in `memory_search`
  tool now searches the same libraVDB-backed memory stores.
- The daemon is a separate operational unit. Treat plugin lifecycle and daemon
  lifecycle as different concerns.
- The system is local-first by design. The critical retrieval path does not
  require a remote embedding service.
- The sidecar transport is stable and explicit, which makes it service-manager
  friendly on macOS, Linux, and Windows.

Good entry points:

- [docs/install.md](./docs/install.md)
- [docs/installation.md](./docs/installation.md)
- [docs/uninstall.md](./docs/uninstall.md)
- [docs/implementation.md](./docs/implementation.md)

## For Researchers And Builders

If you are studying retrieval, memory systems, or agent architecture, the
interesting parts of this repo are:

- continuity-aware assembly:
  `C_total(q) = I union T_recent union Proj(V_rest, q)`
- hybrid ranking instead of pure cosine retrieval
- separation of authored invariants from searchable authored lore
- durable-memory admission via domain-adaptive gating
- local daemon architecture rather than in-process TS vector plumbing
- compaction that preserves recent working context instead of flattening the
  whole transcript

Start here:

- [docs/problem.md](./docs/problem.md)
- [docs/architecture.md](./docs/architecture.md)
- [docs/mathematics-v2.md](./docs/mathematics-v2.md)
- [docs/gating.md](./docs/gating.md)
- [docs/continuity.md](./docs/continuity.md)

## Runtime Facts

- npm package: `@xdarkicex/openclaw-memory-libravdb`
- OpenClaw plugin id: `libravdb-memory`
- minimum host version: `openclaw >= 2026.3.22`
- default daemon data path: `$HOME/.clawdb/data.libravdb`
- default daemon endpoint on macOS/Linux:
  `unix:$HOME/.clawdb/run/libravdb.sock`
- default daemon endpoint on Windows:
  `tcp:127.0.0.1:37421`

## Repository Guide

- [docs/install.md](./docs/install.md): quick install and lifecycle guide
- [docs/installation.md](./docs/installation.md): full installation and
  packaging reference
- [docs/uninstall.md](./docs/uninstall.md): clean shutdown and removal
- [docs/architecture.md](./docs/architecture.md): current implemented system
  architecture
- [docs/implementation.md](./docs/implementation.md): important implementation
  contracts
- [docs/mathematics-v2.md](./docs/mathematics-v2.md): formal scoring and
  optimization reference

## Current Constraint

Because OpenClaw environments can be strict about postinstall downloads,
daemon spawning, and scanner-visible binary bootstrap behavior, the cleanest
supported user path today is:

- install plugin
- install daemon
- assign both slots
- let the plugin connect to a stable local endpoint

That tradeoff is intentional. It keeps the plugin installation surface simple
and auditable while preserving the full local memory engine at runtime.
