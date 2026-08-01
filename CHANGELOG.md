# Changelog

## v1.10.19 — 2026-08-01

### Fixed

- **Cross-tenant search drops same-ID hits from different tenants.** The fan-out
  dedup used `id` alone, so if tenant-a and tenant-b both returned a record with
  the same ID, the second was silently dropped. Now scoped to `tenant + id`.
  Also wrapped fan-out in `try/finally` so the primary tenant key is restored
  even if iteration throws.

## v1.10.18 — 2026-08-01

### Fixed

- **Circuit breaker cooldown not reset on failure class change.** When the
  BeforeTurnKernel failure class changed (e.g., timeout → unavailable), the
  code reset `class` and `consecutive` but retained the old class's
  `cooldownUntil`. The stale cooldown blocked calls even though the new failure
  class hadn't reached its open threshold. Now cleared on class transition.

## v1.10.17 — 2026-08-01

### Fixed

- **Multiline tool-call JSON sanitization.** The old `TOOL_CALL_JSON_RE` regex used
  `[^\r\n]*` and could never match formatted JSON tool calls spanning multiple
  lines. Replaced with a brace-aware, string-aware JSON object scanner that finds
  balanced `{...}` objects, parses as JSON, recursively checks for tool-call
  markers, and strips matches. Adjacent ordinary JSON is preserved. Eliminates a
  path where historical tool syntax in recalled context could prime models to
  repeat tool calls.

## v1.10.16 — 2026-08-01

### Fixed

- **Markdown oversized file retraction.** When an ingested markdown file grows
  beyond `markdownIngestionMaxTokensPerFile`, previously-ingested chunks were
  left in the vector DB as stale authored content. The scan loop now retracts
  cached documents that become oversized via `delete_authored_document`, both in
  the pre-read estimate path and the streamed `too_large` path. Previously
  skipped — now actively cleaned up.

## v1.10.15 — 2026-08-01

### Fixed

- **Non-object metadata JSON crash.** The daemon can return `metadataJson: "null"`
  (valid JSON null) for search results. `parseMetadataJson()` was passing the
  parsed value straight through, causing `TypeError: Cannot read properties of
  null (reading 'collection')` on a public search path. Non-object values (null,
  primitives, arrays) are now treated as missing metadata, falling back to `{}`.

## v1.10.14 — 2026-08-01

### Changed

- **Tool name prefix: `memory_search` → `libravdb_memory_search`, `memory_get` → `libravdb_memory_get`.**
  OpenClaw >=2026.5.x moved `memory_search` and `memory_get` into the core tool catalog,
  colonizing generic names that were the de facto community contract. Prefixing avoids the
  namespace collision while preserving the semantic contract. All other tool names are
  unaffected. Prompt guidance and continuity context messages updated accordingly.

### Added

- **Per-agent memory opt-out (`excludeAgents`, `excludeSubagents`).** Multi-agent gateways
  can now skip ALL LibraVDB memory/context work for specific agents or all subagents.
  `excludeAgents: ["fastbot"]` skips injection, ingestion, compaction, and daemon RPCs for
  a latency-critical voice agent. `excludeSubagents: true` makes every ephemeral subagent
  run lean. Both default off — fully opt-in.

- **Absolute injection ceiling (`tokenBudgetMax`).** Caps memory injection tokens per turn
  independent of the model's context window. On large-window models (1M tokens), the
  existing `tokenBudgetFraction` approach balloons injection to ~200k tokens, trashing the
  prompt cache every turn. `tokenBudgetMax` adds a two-stage ceiling: the daemon budget is
  pre-capped, then the combined system prompt addition is truncated after all injection
  paths land. Only injection is bounded — the conversation window is untouched.

### Fixed

- **Ingest queue false rejection under WAL load.** The daemon's `ingest_markdown_document`
  RPC returns at queue-time (before embed/commit), so `nodesAccepted: 0` is the normal
  async response. The ingest loop was treating this as permanent rejection, spraying false
  `Chunk permanently rejected` warnings on every chunk under load. Rejection is now gated
  on `nodesRejected > 0` — the only signal of actual rejection.

## v1.10.13 — 2026-06-27

### Added — Bot Persona

- **Bot persona.** `set_persona` and `get_persona` tools. Stored as
  `__bot_persona__` user card, injected at session start as `<bot_persona>`.
  Templates: Professional, Creative, Minimalist, Character. Empty string deletes.

## v1.10.6 — 2026-06-26

### Fixed

- **`tenantIdByAgent` schema now accepts object form.** Uses `anyOf` to allow
  `"agent": "tenant"` (string) and `"agent": { "primary": "...", "readAccess": [...] }`
  (object). Fixes OpenClaw core config validator rejecting the object form.

## v1.10.5 — 2026-06-26

### Added

- **Multi-tenant read access.** `tenantIdByAgent` now supports object form with
  `readAccess` for cross-tenant search fan-out. One agent can search its own
  tenant PLUS other agents' tenants. Zero overhead for single-tenant setups —
  fan-out only activates when `readAccess` is configured.
  ```json
  { "jarvis": { "primary": "jarvis", "readAccess": ["shelly", "goku"] } }
  ```
  Writes always go to primary. Backwards compatible — string values unchanged.

## v1.10.4 — 2026-06-26

### Added

- **Configurable `maxRules`.** Set via plugin config. Default 20, 0 disables
  rule creation entirely.
- **Config reference table** includes `tenantIdByAgent` and `maxRules`.

## v1.10.3 — 2026-06-26

### Fixed

- Lockfile sync — pin `@bufbuild/protobuf` to 1.10.1 (1.10.2 doesn't exist).

## v1.10.2 — 2026-06-26

### Added

- **`tenantIdByAgent` config.** Per-agent tenant routing for multi-agent
  deployments. Maps agent IDs to tenant keys.

## v1.10.1 — 2026-06-26

### Added — Hard Constraint Rules Engine

- **Rules agent tools.** `set_rule`, `get_rule`, `list_rules`, and `delete_rule`
  let the agent manage hard constraint rules. Max 20 rules, persisted to disk
  in `~/.openclaw/cache/libravdb/rules.json`.
- **Keyword-based PII enforcement.** Each rule carries comma-separated keywords.
  The `before_agent_reply` hook (`scanReply`) checks every agent reply against
  all rule keywords (substring match, case-insensitive). If a keyword is found,
  the reply is replaced with "I cannot answer that." — zero LLM overhead, zero latency.
- **Behavioral enforcement.** Rules are injected at `prependSystemContext` level
  (AGENTS.md equivalent) so the model treats them as system-level hard constraints.
- **Dual-layer architecture.** Behavioral rules guide the model via system prompt;
  PII rules block violations at the reply dispatch layer. Combined, they provide
  both guidance and hard enforcement.

## v1.10.0 — 2026-06-26

### Added — User Cards & Identity Tracking (Phases 1-4)

- **User card agent tools.** `update_user_card`, `get_user_card`, and
  `list_user_cards` tools let the agent read, write, and list prose identity
  cards for every speaker it interacts with. Cards are stored in the daemon,
  embedded as 768-dim vectors, and linked into the causal graph.
- **Identity-first system prompt.** The memory prompt section now instructs
  the agent to use `get_user_card` or `list_user_cards` FIRST for any
  person-related query, with `memory_search` as supplement only.
- **Multi-speaker support.** A second `before_prompt_build` hook extracts
  speakers from message envelopes (Discord, Telegram, etc.) and injects the
  matching speaker's card as `<speaker_context>` for the current turn.
- **Graph edge walker in `memory_expand`.** `record_id` parameter enables
  causal graph traversal — BFS from any record through `why_ids`/`how_ids`/
  `hop_targets`. The `ExpandSummary` RPC now returns `ConnectedRecord` results
  when `record_id` is set.
- **Fuzzy user lookup.** `get_user_card` supports prefix matching —
  "jez" finds "jez (wurk)" without exact ID.
- **Bootstrap injection.** The main user's card is injected as `<user_context>`
  at session start with "you" framing — the model defaults to THIS understanding
  of the user, not generic scripts.
- **Third-person guard.** Main user card explicitly instructs the model to
  use "you" direct address; speaker cards use "The current speaker is X" framing.

### Changed — Documentation

- Plugin README: renamed "vector service" to "memory kernel" throughout.
- Added Identity Tracking & User Cards section to README.

### Fixed

- **User card tool crash.** `throw new Error` moved inside try/catch in
  `get_user_card` and `update_user_card` — missing parameters no longer
  crash the agent.
- **Third-person narration.** Bootstrap context now appends "Refer to them
  as 'you' directly. Never use third person."

### Dependencies

- Bump `@xdarkicex/libravdb-contracts` to v2.0.27 (`ExpandSummary.record_id`,
  `ConnectedRecord`, edge metadata fields).

## v1.9.9 — 2026-06-22

**Contributor:** Marvinthebored — [PR #356](https://github.com/xDarkicex/openclaw-memory-libravdb/pull/356)
**Signed off by:** xDarkicex

### Fixed
- **Gateway-wide memory ingestion failure on session delete:** The plugin previously shut down the shared vector-service runtime whenever a per-session `delete` event was received (e.g., when a temporary subagent or cron session ended). Because the runtime is a process-wide singleton, this silently broke memory ingestion for all other active sessions until a manual gateway restart. The cleanup lifecycle hook now explicitly checks for `sessionKey === undefined` to distinguish between a per-session delete and a true plugin-scoped teardown, keeping the shared runtime alive for other sessions.

## v1.9.8 — 2026-06-11

**Contributor:** xDarkicex — [PR #339](https://github.com/xDarkicex/openclaw-memory-libravdb/pull/339)
**Signed off by:** xDarkicex

### Removed
- **Cursor-gated tool protocol gate system (Gates 1-4) from `normalizeAssembleResult`.** Commit `78da771` (v1.9.1) added live tool protocol preservation for Qwen 3.5 32B INT4 that intercepted the daemon's echoed `visibleMsgs` and re-injected source-format tool messages via cursor tracking. This caused two regressions for all other models:
  - **T0 race (~50% hit rate on tool-call turns):** v1.9.0 made `afterTurn` async. Gate 1 cursor computation raced against pending daemon ingestion, producing intermittent duplicate tool execution and tool protocol loss. The model would re-execute tools it had already run or forget what tools returned.
  - **Content-based dedup gap:** The dedup key (`${role}\0${content}`) missed the same tool call formatted differently between daemon-flattened `[tool:name]` and source-format JSON blocks.

### Changed
- `normalizeAssembleResult()` now uses `sourceMessages` (`args.messages`) directly as the transcript. The daemon's `visibleMsgs` (which strips `toolResult`/`tool` roles via `normalizeMemoryMessage`) is ignored. Tool protocol passes through intact with no re-classification or re-injection.
- Daemon memory context is injected via `systemPromptAddition` only — the industry-standard pattern used by mem0, lossless-claw, and supermemory.
- Async ingestion drain added before daemon RPC calls with 5s cancellable timeout, preventing cursor-staleness from the `afterTurn` queue.

### Fixed
- **Tool call loop regression** reported by Peetiegonzalez and others: agents no longer re-execute completed tool workflows on innocuous follow-up messages ("not bad", "thanks").
- **Tool protocol amnesia:** agents now remember their tool calls and results across turns because the full transcript (including `toolResult` messages) is preserved.

### Removed (26 functions/structures)
`consumeLiveToolAtCursor`, `findLiveToolSourceInCurrentTurn`, `findMatchingSourceMessageIndex`, `getSourceMessageIndex`, `SourceIndex`, `sourceMessageIndexCache`, `getNormalizedSourceContent`, `normalizedContentCache`, `getHistoricalToolSource`, `isFlattenedHistoricalToolActivity`, `shouldRetainHistoricalToolMemory`, `isHistoricalAssistantActionPromise`, `isProviderReplayRole`, `sanitizeProviderReplayMessage`, `sanitizeProviderReplayMessages`, `getToolResultCallId`, `getKernelToolCallIds`, `hasLiveToolCallBefore`, `hasCompletedAssistantResponseAfter`, `toolProtocolBeforeCache`, `getToolProtocolBeforeCache`, `hasToolProtocolBeforeSinceLastUser`, `findSourceMessageIndex`, `isHistoricalToolDerivedAssistantReply`, `preserveLiveToolProtocolMessage`, and 2 unused regex constants.

### Tested
- 72/72 unit tests passing
- Live-tested against [tool-bench-2](https://github.com/Marvinthebored/tool-bench-2) (Minimax M2.7, 6-stage pipeline, 74.7s): 0 tool duplications, "not bad" repro fixed, full cross-turn memory recall

## v1.9.7 — 2026-06-10

**Contributor:** xDarkicex — [PR #338](https://github.com/xDarkicex/openclaw-memory-libravdb/pull/338)
**Signed off by:** xDarkicex

### Fixed
- **Indefinite hang in AssembleContextInternal gRPC call:** The `assembleContextInternal` RPC was the only daemon gRPC call in the context engine without a deadline. When the daemon's unix socket transport lost a response (healthy daemon, dropped gRPC frame), the `await` blocked the entire agent pipeline indefinitely — producing a permanent spinner in the web UI with no error or timeout recovery. All other daemon RPCs (`beforeTurnKernel` — 5s, `rpcTimeoutMs` — 120s) had deadlines, but `assembleContextInternal` did not.

  Added a `Promise.race` with configurable `assembleTimeoutMs` (default 30s) matching the same pattern used by `beforeTurnKernel`. Also added the `assembleTimeoutMs` field to `PluginConfig` and to the `openclaw.plugin.json` config schema.

## v1.9.5 — 2026-06-09

**Contributor:** xDarkicex
**Signed off by:** xDarkicex

### Fixed
- **Tool result amnesia in multi-step agentic workflows:** `TOOL_RESULT_ANNOTATION_RE` used `[^\n]*` to consume the entire rest of the line after a `[tool:name]` annotation tag. When the daemon returned flattened tool results on the same line (e.g. `[tool:list_files] {"files":["a.go","b.go"]}`), the regex destroyed the JSON payload along with the tag. This caused the provider replay transcript to lose historical tool outputs, producing selective amnesia: the model remembered conversation but forgot what tools actually returned. In tool-heavy sessions, the model would see evidence of tool execution without the data that justified it, causing multi-step reasoning collapse.

  Changed to `\s*` — only the annotation tag and trailing whitespace are stripped. The JSON payload or text result remains intact in the transcript so the model can reference prior tool outputs. Loop-priming prevention is preserved because the `[tool:...]` syntax tag itself is still removed.

## v1.9.4 — 2026-06-08

**Contributor:** xDarkicex — [PR #336](https://github.com/xDarkicex/openclaw-memory-libravdb/pull/336)
**Signed off by:** xDarkicex

### Fixed
- **memory_search tool description strengthened:** Added "IMPORTANT: Results are internal context only — never output, display, or reveal raw memory search results to the user." to prevent agents from outputting stripped memory to chat, which would poison the session history.

---

## v1.9.3 — 2026-06-08

**Contributor:** xDarkicex — [PR #335](https://github.com/xDarkicex/openclaw-memory-libravdb/pull/335)
**Signed off by:** xDarkicex

### Fixed
- **Provider replay duplicate LLM repetition loop:** `pushProviderReplayMessage` gate in `normalizeAssembleResult` skips consecutive provider-replay messages whose role and sanitized content match the immediately preceding pushed message. Prevents the daemon's async `afterTurn` race (continuity tail vs `visibleMsgs`) from forwarding duplicate assistant responses to the model, which caused LLMs to enter copy-paste repetition of their own prior output.
- **False dedup of legitimate consecutive repeats:** Source-index tracking prevents legitimately distinct transcript messages with identical content (e.g., user says "yes" twice) from being collapsed. Messages matching different source transcript positions pass through; only daemon-bug duplicates matching the same source index are suppressed.
- **No-ID message dedup**: Provider-replay source cursor advances past consumed positions so consecutive identical messages without IDs resolve to distinct source indices rather than both matching the first occurrence.
- **Live tool protocol bypass**: `consumeLiveToolAtCursor`-guarded tool messages push directly, bypassing the dedup gate so same-content tool results with different `toolCallId` linkages are never collapsed.

---

## v1.9.2 — 2026-06-07

**Contributor:** xDarkicex — [PR #334](https://github.com/xDarkicex/openclaw-memory-libravdb/pull/334)
**Signed off by:** xDarkicex

### Fixed
- **Compaction regression (v1.9.1):** Reverted unintended WIP predictive compaction code that was squash-merged in PR #331. `compactSessionTokenBudget: 0` no longer disables all automatic compaction. Restored v1.9.0 cap semantics (`Math.min(withBounds, budget)`) and removed unreviewed cursor tracking and repeat-suppression guard.
- **Result replay regression (v1.9.1):** `canonicalizeCompactedSessionContextBlocks` no longer strips the render ledger prose that models need to understand session state. The first (latest, most complete) render ledger is preserved alongside the JSON state line; only repeated render ledgers from older compaction cycles are stripped. Boundary detection uses the full heading set (Artifacts, Constraints, Open Next Steps, Extracted context anchors) with seen-heading tracking to keep exactly one ledger.

---

## v1.9.1 — 2026-06-07

**Contributor:** Juan — [PR #331](https://github.com/xDarkicex/openclaw-memory-libravdb/pull/331)
**Signed off by:** xDarkicex

### Fixed
- Daemon `<compacted_session_context>` blocks with accreting render ledgers (Artifacts, Constraints, Open Next Steps, Extracted context anchors) no longer reach provider-visible prompt replay. The sanitizer preserves the canonical JSON state line and discards the repeated rendered ledger. Observed reduction: ~262k chars → ~4k chars, ~67k tokens → ~5.3k tokens.
- Post-sanitization `estimatedTokens` is recomputed when `systemPromptAddition` was reduced, preventing stale daemon estimates from propagating.
- Non-JSON compacted blocks and blocks without render ledger headings pass through unchanged.

---

**Contributor:** xDarkicex — [PR #332](https://github.com/xDarkicex/openclaw-memory-libravdb/pull/332)
**Signed off by:** xDarkicex

### Fixed
- Sanitization pipeline order corrected: `canonicalizeCompactedSessionContextBlocks` now runs before `sanitizeToolCallPatterns` so canonicalization sees raw daemon text. Prevents `sanitizeToolCallPatterns` from potentially breaking JSON first-line detection inside compacted blocks.
- Token recomputation test tightened to seed a deliberately stale large estimate (50k) instead of a pass-through-friendly small value (64).

---

## v1.9.0 — 2026-06-06

**Contributor:** xDarkicex — [PR #329](https://github.com/xDarkicex/openclaw-memory-libravdb/pull/329)
**Signed off by:** xDarkicex

### Added
- `optimizationMemoCacheSize` config option (default 1000) to bound string memoization caches.
- `FLUSH_ASYNC_INGESTION` Symbol-keyed test hook — drains queued ingestion deterministically without being discoverable via string enumeration in production.
- `memory_describe`, `memory_expand`, and `memory_grep` recall tools now register in all runtime modes (previously gated behind memory slot ownership). Enables recall hierarchy on slot-unset deployments.
- `before_prompt_build` hook captures trigger type for BeforeTurnKernel gating (skips semantic retrieval on automated triggers like heartbeat/cron).
- `setOptimizationMemoCacheSize(size)` exported function for runtime cache tuning.

### Changed
- **Memoization layer:** `normalizedContentCache` (WeakMap), `metadataEnvelopeCache`, and `toolCallSanitizeCache` (Maps with bounded eviction) eliminate repeated regex + JSON parse + normalize ops on the hot path. Amortized O(1) per call where cache hits occur.
- **O(1) source lookups:** `SourceIndex` (WeakMap-keyed by sourceMessages array) with lazy `byContent`/`byId` Maps replaces O(N) linear scans in `findMatchingSourceMessageIndex`. Rebuilds only on array growth.
- **Async ingestion:** `afterTurn` returns `{ ok: true, queued: true }` immediately. Heavy work (daemon RPC, manifest reconciliation, predictive compaction, embedding prewarm) executes on a serial per-session promise chain off the critical path. Sync preflight returns `{ skipped: true }` when no new messages exist.
- **Post-tool continuation cache:** when `assemble` detects live tool protocol after the last user message, it bypasses `BeforeTurnKernel` + `assembleContextInternal` + Exact Recall RPCs and reuses the cached system prompt addition. Gated by `hasLiveToolProtocolAfterLastUser()`.
- **Parallel exact recall:** missing-token RPCs now use `Promise.all` instead of sequential `for...of`.
- **Duplicate sanitization removed:** `sanitizeProviderReplayMessages` no longer called on the happy path — `normalizeAssembleResult` already produces fully sanitized output.
- **`dispose()` drain timeout:** 5-second `Promise.race` prevents indefinite shutdown blocking on a stuck daemon. Warns when tasks remain after timeout.
- **Memory prompt rewritten:** simpler header (`## LibraVDB Memory`), per-question search guidance, recall hierarchy docs, removed stale timestamp-comparison and "actively retrieve" guidance.

### Fixed
- Cursor auto-advance now uses precise `findMatchingSourceMessageIndex` lookups when messages are dropped — prevents inert assistant preambles from stalling the live tool cursor and orphaning downstream tool protocol.
- `SourceIndex` detects in-place array mutation via length fingerprint and rebuilds lazily (O(N) only when array genuinely grows).
- Manifest reloaded inside the queued async task (not captured at preflight time) to prevent stale snapshot races across sequential queued ingestion tasks.
- `asyncIngestionQueues` entries self-delete on settle; `postToolRecallCache` evicts oldest entry at 100; all string caches use `evictOldestHalf` (proportional insertion-order eviction) to avoid bursty clearance.
- 4 pre-existing test failures fixed: stale prompt assertions in `memory-provider.test.ts`, stale tool/hook arrays in `slot-conflict.test.ts`, and stale invariant check in `checklist-validation.test.ts`.

---

## v1.8.10 — 2026-06-03

**Contributor:** xDarkicex — [PR #304](https://github.com/xDarkicex/openclaw-memory-libravdb/pull/304)
**Signed off by:** xDarkicex

### Changed
- `memory_search` and `memory_grep` tool descriptions now instruct models to skip searching when the answer is already visible in the context window (prior turns, `<context_memory>` blocks, or context assembly). Prevents weaker models from firing redundant searches for information that has already been retrieved.
- `<context_memory>` preamble strengthened: explicitly tells the model the content has "ALREADY BEEN RETRIEVED" and forbids re-searching for topics answered there.

---

**Contributor:** computment — [PR #268](https://github.com/xDarkicex/openclaw-memory-libravdb/pull/268)
**Signed off by:** xDarkicex

### Fixed
- Integration test suite now runs in the default `pnpm run check` gate. Previously the gate was green while integration tests were silently broken.
- Added `clean:test` script to purge stale `.ts-build` artifacts so deleted or renamed tests cannot execute from build cache.
- Restored missing `FsDirentLike` type that broke `markdown-ingest.test.ts`.
- Updated `host-flow.test.ts` expectations for current replay-safe prompt-injection behavior.
- Compact result normalization no longer serializes absent fields as `undefined`.

---

**Contributor:** Juan — [PR #306](https://github.com/xDarkicex/openclaw-memory-libravdb/pull/306)
**Signed off by:** xDarkicex

### Security
- Pinned `undici` to 8.3.0 via `pnpm.overrides` to patch transitive vulnerable resolutions.
- Bumped `openclaw` devDependency from 2026.4.11 to 2026.4.23, clearing 9 CVEs:
  - CVE-2026-44109 (critical): Feishu webhook and card-action validation fail-closed
  - CVE-2026-43585 (critical): Gateway HTTP endpoints re-resolve bearer auth after SecretRef rotation
  - CVE-2026-45004 (high): Arbitrary code execution via attacker-controlled `setup-api.js`
  - CVE-2026-43530 (high): Busybox/toybox applet execution weakened exec approval binding
  - CVE-2026-43528 (high): `config.get` redaction bypass through `sourceConfig`/`runtimeConfig` aliases
  - CVE-2026-44110 (high): Matrix room control-command authorization trusted DM pairing-store entries
  - CVE-2026-44118 (high): MCP loopback owner context derived from server-issued bearer tokens
  - CVE-2026-44114 (high): Workspace dotenv could override runtime-control environment variables
  - GHSA-cwj3-vqpp-pmxr (high): Gateway config mutation guard allowed unsafe model-driven config writes
- Raised `minHostVersion` to `>=2026.4.23`.

## v1.8.9 — 2026-06-01

**Contributor:** fuller-stack-dev — [PR #294](https://github.com/xDarkicex/openclaw-memory-libravdb/pull/294)  
**Signed off by:** xDarkicex

### Fixed
- Declared `memory_recall`, `memory_expand`, and `memory_grep` tools in `openclaw.plugin.json` manifest. Tools were functional but missing from the plugin manifest, causing discovery failures in OpenClaw.

---

**Contributor:** JARVIS-Glasses (IWhatsskill) — [PR #297](https://github.com/xDarkicex/openclaw-memory-libravdb/pull/297)  
**Signed off by:** xDarkicex

### Fixed
- Sanitized subagent expansion budgets: `NaN`, `Infinity`, `-Infinity`, and negative config values now fall back to the documented default of 8000 tokens instead of producing unbounded or invalid grants.
- Hardened `consumeSubagentBudget()` to reject non-finite and non-positive requested grants.

---

**Contributor:** xDarkicex — [PR #299](https://github.com/xDarkicex/openclaw-memory-libravdb/pull/299)  
**Signed off by:** xDarkicex

### Fixed
- Session continuity context now uses a three-tier fallback instead of returning `null`: no pointer → no prior session, pointer without `summary_id` → not compacted, `expandSummary` fails → expansion failed. Each fallback directs the LLM to use `memory_search` for recovery.
- Continuity pointer search upgraded to natural language query with wider k to avoid crowding out the exact ID match.
- Guarded against undefined `session_id` in continuity fallback text.
- Reduced exact recall search breadth from 32 to 10.
- Requires daemon v1.8.8.

