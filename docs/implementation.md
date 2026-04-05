# Implementation Notes and Interfaces

This document explains the implemented contracts that are easy to miss when
reading the code piecemeal.

## Memory Kind Plus Explicit Context Engine Registration

The plugin declares `kind: ["memory", "context-engine"]` in
[`openclaw.plugin.json`](../openclaw.plugin.json), but still registers both a
context engine and a memory prompt section in [`src/index.ts`](../src/index.ts).

Why:

- the intended runtime contract is that `libravdb-memory` owns both the
  `memory` and `contextEngine` slots together
- the runtime behavior still needs explicit lifecycle hooks for:
  - `bootstrap`
  - `ingest`
  - `assemble`
  - `compact`
- the lightweight memory prompt section remains useful as a separate early
  durable-recall pass

This is why the code registers both `registerContextEngine("libravdb-memory", …)`
and `registerMemoryPromptSection(...)` instead of relying on only one hook.

## Why Ingest Is Fire-and-Forget

Implemented in [`src/context-engine.ts`](../src/context-engine.ts).

Session insertion is intentionally fire-and-forget:

- the active conversation should not block on persistence
- session memory is useful immediately, but not allowed to become a hard
  dependency for response generation

The current code writes to `session:<sessionId>` asynchronously and only then
attempts the more expensive durable-promotion path for user turns.

## Why Gating Uses Exactly Two Searches

Implemented in [`sidecar/server/rpc.go`](../sidecar/server/rpc.go).

`gating_scalar` performs exactly:

1. one search against `turns:<userId>`
2. one search against `user:<userId>`

Novelty and durable-memory saturation reuse the same `user:` hit set. This keeps
the RPC bounded and predictable. There is no third store query for novelty.

## Why the Token Estimator Uses Bytes/4 in the Gate

Implemented in [`sidecar/compact/tokens.go`](../sidecar/compact/tokens.go).

The gate's specificity term uses:

$$
\mathrm{EstimateTokens}(t)=\max(\lfloor \mathrm{len}(t)/4 \rfloor, 1)
$$

Why not word count:

- word count behaves badly on code
- file paths, stack traces, and identifiers are token-dense but word-sparse
- bytes/4 is cheap and stable across prose, code, and mixed technical content

Important boundary:

- this is the gating estimator
- prompt-budget fitting uses a separate host-side chars-per-token heuristic in
  [`src/tokens.ts`](../src/tokens.ts)

## Why the Daemon Uses a Stable Endpoint

Implemented in [`sidecar/main.go`](../sidecar/main.go) and
[`src/sidecar.ts`](../src/sidecar.ts).

The daemon binds to a stable, predictable local endpoint instead of advertising
a per-process endpoint on stdout.

Why:

- the published plugin no longer spawns the process itself
- connect-only plugin startup needs a known endpoint contract
- user services such as `systemd --user`, launchd, and Homebrew service support
  work better with a stable socket or loopback address
- Windows still uses a fixed loopback TCP endpoint because Unix sockets are not
  the common user-service path there

Current defaults:

- macOS/Linux: `unix:$HOME/.clawdb/run/libravdb.sock`
- Windows: `tcp:127.0.0.1:37421`

The plugin resolves that configured endpoint and then establishes the JSON-RPC
transport.

## Why Degraded Mode Continues the Session

Implemented in [`src/sidecar.ts`](../src/sidecar.ts) and
[`src/context-engine.ts`](../src/context-engine.ts).

If the daemon connection fails repeatedly, the plugin enters degraded mode instead of
failing the chat session.

Why:

- memory augmentation is valuable, but it is not allowed to become a hard
  dependency for the core conversation path
- the safe fallback is "continue without memory augmentation" rather than
  "reject the entire turn"

This is deliberate fault containment.

## `ownsCompaction: true`

Implemented in [`src/context-engine.ts`](../src/context-engine.ts).

The context engine factory returns `ownsCompaction: true`.

This tells the host that compaction belongs to the memory engine lifecycle
itself. In this plugin, compaction is not an optional helper or an external
maintenance job; it is part of the actual memory system contract.

## Interface: `GatingConfig`

Defined in [`sidecar/compact/gate.go`](../sidecar/compact/gate.go).

```go
type GatingConfig struct {
    W1c float64
    W2c float64
    W3c float64
    W1t float64
    W2t float64
    W3t float64
    TechNorm  float64
    Threshold float64
}
```

Field meanings:

- `W1c`, `W2c`, `W3c`: conversational-branch weights for novelty `H`,
  repetition gate `R`, and conversational structure `D`
- `W1t`, `W2t`, `W3t`: technical-branch weights for specificity `P`,
  actionability `A`, and technical structure `Dtech`
- `TechNorm`: normalization constant for technical-density saturation
- `Threshold`: durable-promotion cutoff used by the host

Contract:

- all weights are intended to be in `[0,1]`
- each branch should sum to `1.0` by convention
- `TechNorm <= 0` is normalized back to the default inside `computeT`
- zero values are not generally meaningful outside tests; callers should use
  `DefaultGatingConfig()` or config-derived values from [`sidecar/main.go`](../sidecar/main.go)

## Interface: `GatingSignals`

Defined in [`sidecar/compact/gate.go`](../sidecar/compact/gate.go).

```go
type GatingSignals struct {
    G float64
    T float64
    H float64
    R float64
    D float64
    InputFreq     float64
    MemSaturation float64
    P     float64
    A     float64
    Dtech float64
    Gconv float64
    Gtech float64
}
```

Field meanings:

- `G`: final gate score in `[0,1]`
- `T`: technical-density branch weight in `[0,1]`
- `H`: novelty score in `[0,1]`
- `R`: repetition product gate in `[0,1]`
- `D`: conversational structural load in `[0,1]`
- `InputFreq`: normalized repeated-mention signal in `[0,1]`
- `MemSaturation`: normalized durable-memory saturation signal in `[0,1]`
- `P`: technical specificity score in `[0,1]`
- `A`: technical actionability score in `[0,1]`
- `Dtech`: technical structural load in `[0,1]`
- `Gconv`: weighted conversational branch score
- `Gtech`: weighted technical branch score

Zero-value behavior:

- an all-zero `GatingSignals` struct does not mean "valid low-confidence turn";
  it usually means "not computed yet"
- missing metadata readers should treat absent values as `0.0` and not panic

Inputs vs outputs:

- `GatingConfig` is input
- `turnHits`, `memHits`, and `text` are inputs to `ComputeGating`
- `GatingSignals` is output and is intended to be persisted in metadata

## Interface: JSON-RPC Surface

Implemented in [`sidecar/server/rpc.go`](../sidecar/server/rpc.go).

Method names are snake_case in the actual protocol.

### `health`

- request: `{}`
- response: `{ ok: boolean, message: string }`
- errors: none expected unless transport fails

### `status`

- request: `{}`
- response:
  `{ ok, message, turnCount, memoryCount, gatingThreshold, abstractiveReady, embeddingProfile }`
- errors: none expected unless transport fails

### `ensure_collections`

- request: `{ collections: string[] }`
- response: `{ ok: true }`
- errors:
  - collection creation failure in the Go store

### `insert_text`

- request:
  `{ collection: string, id: string, text: string, metadata: object }`
- response: `{ ok: true }`
- errors:
  - embedding failure
  - record validation failure
  - store insertion failure

### `gating_scalar`

- request: `{ userId: string, text: string }`
- response: full `GatingSignals` JSON payload
- errors:
  - search failure on `turns:<userId>` or `user:<userId>`

### `search_text`

- request:
  `{ collection: string, text: string, k: number, excludeIds?: string[] }`
- response: `{ results: SearchResult[] }`
- errors:
  - query embedding failure
  - store search failure

### `list_by_meta`

- request: `{ collection: string, key: string, value: string }`
- response: `{ results: SearchResult[] }`
- errors:
  - store listing failure

### `export_memory`

- request: `{ userId?: string }`
- response:
  `{ records: Array<{ collection, id, text, metadata }> }`
- errors:
  - collection listing failure

### `flush_namespace`

- request: `{ userId: string }`
- response: `{ ok: true }`
- errors:
  - missing `userId`
  - delete-by-prefix failure

### `delete`

- request: `{ collection: string, id: string }`
- response: `{ ok: true }`
- errors:
  - delete failure

### `delete_batch`

- request: `{ collection: string, ids: string[] }`
- response: `{ ok: true }`
- errors:
  - batch delete failure

### `compact_session`

- request: `{ sessionId: string, force: boolean, targetSize?: number }`
- response:
  `{ didCompact, clustersFormed, turnsRemoved, summaryMethod, meanConfidence }`
- errors:
  - missing session id
  - extractive summarizer unavailable
  - summary insertion failure
  - summarization failure

### `flush`

- request: `{}`
- response: `{ ok: true }`
- errors:
  - store flush failure

## Interface: Context Engine Lifecycle

Implemented in [`src/context-engine.ts`](../src/context-engine.ts).

The factory returns an object with this effective shape:

```ts
{
  ownsCompaction: true,
  bootstrap(args: ContextBootstrapArgs): Promise<{ ok: true }>,
  ingest(args: ContextIngestArgs): Promise<{ ingested: boolean }>,
  assemble(args: ContextAssembleArgs): Promise<{
    messages: MemoryMessage[],
    estimatedTokens: number,
    systemPromptAddition: string,
  }>,
  compact(args: ContextCompactArgs): Promise<{ ok: true, compacted: boolean }>,
}
```

### `bootstrap`

Input:

- `sessionId`
- `userId`

Behavior:

- ensures `session:`, `turns:`, `user:`, and `global` collections exist

### `ingest`

Input:

- `sessionId`
- `userId`
- `message`
- `isHeartbeat?`

Behavior:

- must not block the session on best-effort persistence
- writes all non-heartbeat messages to session memory
- only user turns go through the durable gating path

### `assemble`

Input:

- `sessionId`
- `userId`
- `messages`
- `tokenBudget`

Behavior:

- must not mutate the incoming `messages` array in place
- searches three scopes in parallel
- hybrid-ranks and budget-fits the result set
- prepends selected memories as synthetic system messages
- falls back cleanly to the original message list on failure

### `compact`

Input:

- `sessionId`
- `force?`
- `targetSize?`

Behavior:

- delegates to the sidecar `compact_session` RPC
- returns `{ ok: true, compacted }`
- treats compaction failure as non-fatal to the active session
