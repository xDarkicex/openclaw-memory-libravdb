# Smart history hydration: TypeScript serving core

Status: opt-in adapter; deployed locally behind `historicalToolReplay=smart`.
`recall` remains the immediate configuration rollback.

The adapter uses OpenClaw's scoped, generation-aware transcript SDK, including
SQLite-backed sessions. Background capture stores compact descriptors and original
transcript pointers in a dedicated LibraVDB collection per tenant/session/audience.
It indexes only completed, balanced tool-backed turns. Associated reasoning can
be retrieved alongside tool results; ordinary social reasoning is not indexed.
Original messages are never rewritten. Index writes are idempotent across restart.

Semantic nomination uses `SearchText`, not lexical `RankCandidates`. The initial
conservative score gate is 0.75 (a ranking score, not a probability). A production
calibration corpus is still needed; low-scoring relevant queries can be missed.
Low-information continuation prompts can reuse the active verified frame across
social/no-op turns. Concrete new subjects displace it. Final answers and the
active user/tool exchange remain in the host transcript.

Evidence is explicitly partial: at most eight 1024-character spans, at most two
per block, prioritizing tool results. Retrieval packs at most two frames and four
spans within 16 KB and a two-second serving deadline. Beginning and terminal
transcript anchors are validated, and each returned span is hash checked. A
missing or invalid anchor never causes broad replay. This is bounded source
evidence retrieval, not the full EventFrame forecasting/learning system.

Background catch-up reads paced batches of at most 256 bounded single-message
pages and schedules another batch while a tail remains. It does not require more
user turns to reach recent work or block the model waiting for ingestion.
The host retains at most 64 session adapters per runtime, evicting idle adapters
after 30 minutes when admitting another session. Post-tool continuations retain
the same turn's query decision but revalidate evidence; hydration never modifies
active tool protocol. Neither the adapter nor its owner caches rendered packets.

This translates the useful serving concepts from EventFrame into TypeScript.
It neither imports eventframed nor reproduces its forecasting, posterior,
residual-learning, agency, or ontology machinery. Conceptual reference:
https://github.com/JuanHuaXu/eventframe-whitepaper/blob/b74058ab2d7eae80bbf9ef0a93f2ea11603b4127/paper.md

## Implemented

`src/smart-hydration.ts` owns the serving order:

1. Take a query, up to two eligible recent frames, and host-resolved reply IDs.
2. Nominate scoped compact frames, reserve room for one level of typed links.
3. Rerank descriptors, excluding raw tool payloads and recorded analysis.
4. Apply an explicit relevance threshold, frame/read limits, and byte budget.
5. Read only the selected original evidence references.
6. Verify scope, event, revision, byte length, and SHA-256 before injection.
7. Return escaped historical reference context and retrieval diagnostics.

Who/what/when/where/why/how fields carry observed/inferred status and source
references. The caller must supply evidence-backed descriptors; this component
does not invent a person's identity or a causal explanation from prose.
Temporal availability is distinct from the event's described date.

The byte budget includes wrapper and escaping overhead. It is deliberately not
called an exact tokenizer count. A production adapter must budget these bytes
against the actual remaining context, without silently evicting live tool
protocol. Large evidence should have independently addressable, verified spans;
the planner does not select an arbitrary prefix and call it complete evidence.

The planner never accepts or modifies the active provider transcript. Current
and unresolved exchanges stay outside this optimization. Matching similarity
does not confer instruction authority. XML escaping prevents delimiter breakout,
not semantic prompt injection or guaranteed model compliance.

## Serving contracts

### Inactivity window

`HydrationWorkingSet` is an optional RAM-only wrapper owned by one host
conversation scope. It retains at most 100 frame IDs (maximum 4096 characters
each) and their last packed user-turn ordinals. No raw evidence is cached.
The host must serialize calls and provide the same ordinal for tool steps/retries
within one user turn. Older ordinals and mismatched scopes are rejected.

A frame expires before selection on the fifth subsequent turn without packed
reuse. Selection on turn 4 after selection on turn 0 extends availability through
turn 8; it expires on turn 9 unless selected again. Nomination, weak matches, and
failed packets do not renew it. An empty greeting packet does not replay retained
evidence. A bounded dialogue classifier preserves the active frame for exact
social acknowledgements and treats short continuation acts such as "go on" as an
explicit reference. Substantive turns clear or replace that pointer. Transcript
catch-up reconstructs the same state, and a topic epoch prevents late background
capture from reviving displaced work. Repeated assembly within one user turn
retains the initial query and classification decision. Retained IDs are refreshed through
scoped `index.get`; normal nomination retains candidate capacity. Explicit
references can still rediscover expired frames from durable storage.

The host must call `clear()` on reset or dispose the instance on scope/task
replacement. Concurrent calls/reset fail explicitly. The production owner keys
instances by tenant, session and audience; transcript generations are validated
again before evidence can be returned. A reset clears active continuity, pending
capture, and the working set; generation guards discard in-flight older work.

The owner uses a host message `id` when present, otherwise object identity (weakly
held), never serialized text or timestamps. Separate identical messages therefore
advance inactivity; repeated assembly of the same message does not. The current
SDK does not expose the host's internal logical-turn ID to `assemble`. Hosts that
clone messages without IDs conservatively get a new turn and no cross-clone
post-tool reuse, rather than incorrectly retaining historical evidence. A stable
host entry ID is required for retry continuity across such clones. One bounded
cursor validation read precedes serving, within the existing two-second deadline;
anchors and evidence are re-read even for repeated assembly.

### Lifecycle regression evidence (2026-09-10)

Review baseline `1a30f01` reproduced stale same-key replay both when reset had not
yet been refreshed and after refresh observed it. Both reset regressions and a
changed-evidence regression failed before the correction. The equal-message
hash also kept a frame after five separate greetings; distinct keys expired it.

Focused controls now cover separate identical messages, repeated assembly of one
message, stable-ID clones, equal timestamps without IDs, reset during in-flight
retrieval, terminal/payload changes, and reduced byte budgets. Unavailable reads
must not pause expiry or preserve displaced topics. These are synthetic adapter
tests using the owner's exported key function, not live Gateway reproductions.
Run `pnpm check` for the complete unit/integration/probe gate and `pnpm build` for
the packaged build. No production deployment or new latency claim accompanies
this review correction.

### Follow-up lifecycle corrections

At baseline `b709ef1`, controlled tests reproduced three failures:

- Completing older assembly A after B replaced B's owner key and prevented B's
  post-tool hydration. Ownership is now published before awaiting hydration;
  stale completions cannot replace the key or attach their packet.
- Three timed-out head checks started three unresolved reads. One outstanding
  head read is now the limit per adapter. Later checks fail unavailable without
  starting I/O or attaching more waiters; settlement reopens admission. This does
  not claim cancellation of the one stalled SDK read.
- All transcript SDK calls additionally share a two-read admission limit per
  adapter: head, anchor, terminal, evidence, and background capture. This permits
  one capture read alongside serving; saturated callers return unavailable
  without queuing. Slots remain occupied until the underlying read settles,
  even after the serving deadline. Cancelled serving work cannot start further
  transcript reads. Rejections release slots; close prevents new admission.
- A completed transcript tail yielded zero frames until another user entry
  became visible. Capture now seals a verified completed tail at the read
  boundary. Unresolved tails remain unindexed, and repeated refreshes neither
  duplicate the frame nor renew its inactivity window. Capture is still async:
  serving can miss evidence while catch-up is in progress.

Regression controls cover serial owner ordering, stalled-read recovery, tail
completion without a subsequent user, unresolved tails, and retention expiry.
These are deterministic adapter/owner-block tests, not live Gateway proof or new
performance measurements. No production configuration changes are required.

The head-only bound in `eb1dc27` did not cover stalled anchors: four attempts
started four unresolved reads. New regressions stall anchor, terminal, and
evidence cursors separately, enforce the shared limit, and verify recovery after
settlement. Controls also verify that a pending capture read permits healthy
serving and that rejected SDK reads release their slots. This is bounded
admission, not a claim that the SDK can cancel already-running I/O.

- `HydrationIndex`: canonical frame nomination and reranking, with tenant,
  session/audience and as-of filtering BEFORE the candidate limit. Retrieval
  must work for paraphrases as well as exact terms. Rank scores are not assumed
  calibrated probabilities.
- `EvidenceArchive`: scoped access to original immutable records or spans,
  enforcing maximum bytes while reading and aborting underlying I/O on timeout.
- Background frame capture: bounded asynchronous processing, source-versioned
  idempotency, durable source pointers, and no raw evidence in the semantic index.
- Host adapter: resolve reply references from trusted metadata; attach the packet
  as historical context, keep current tool protocol exact, expose deferred/missing
  evidence honestly, and support explicit bounded reads for detailed follow-ups.

Do not back this with a second ad-hoc transcript database in the plugin.
Reuse original session storage and the production backend's supported indexing
contracts after validating their semantics. An unavailable adapter means no
hydrated packet, not unrestricted replay of the entire transcript.

## Evidence and limits

Thirteen focused controls cover: preserved historical analysis, empty irrelevant
selection, scope/time/live exclusion, explicit reply references, pre-read budgets,
exact evidence de-duplication, stale or corrupt references, malformed ranking,
cancellation, delimiter escaping, reranking before packing, linked corrections,
and bounded recent-query context. These test controlled retrieval responses;
they do not establish the quality of the production embedding or ranker.

Read-only production RankCandidates probes found a certificate frame for
"TLS certificates" but returned no frame for
"Why did the secure connection fail?". No fixture was inserted into production.
This falsifies treating that endpoint alone as sufficient semantic nomination;
it does not prove the backend's indexed vector search is broken.

Promotion requires real indexed-frame positive/paraphrase and greeting-negative
controls; why/continue with recent context; exact evidence recovery after restart;
wrong-participant and stale-correction controls; live post-tool continuation; and
held-out answer-quality plus cold/warm latency comparison against full replay and
the deployed rescue. Component benchmarks do not establish live Gateway latency.

## Branch scope and reproduction

This feature branch is based on upstream v1.10.25 and excludes the provider-replay
pressure changes in PR #387. It includes the recall-only projection required to
omit completed historical evidence before selectively restoring verified spans.
The default remains `full`; configure `plugins.entries.libravdb-memory.config.historicalToolReplay`
as `smart` to opt in, `recall` for omission without hydration, or `full` to restore
the existing replay policy. No tool-schema or llama.cpp template changes are part
of this feature.

Run `pnpm build` and `pnpm check` for the build, unit suite, and integration suite.
For real indexed synthetic evidence, run:

```sh
BENCH_CONFIG=/path/to/test-openclaw.json node scripts/probe-hydration-adapter.mjs
```

This probe writes to a random scoped collection, tests greeting exclusion and two
related queries after adapter recreation, and deletes inserted records in its
cleanup block. The daemon must support the configured transport and SearchText.

For a Gateway test, export a session report using the test Gateway's
`gateway call sessions.list --json`, then set `SESSIONS_REPORT`,
`PROBE_SESSION_KEY`, `GATEWAY_CLI`, and `PROBE_OUTPUT` before running
`node scripts/probe-hydration-gateway.mjs 'hello'`. Use an explicitly disposable
session: `deliver:false` prevents channel delivery but still persists transcript
turns and can trigger ingestion. Clean that test session using the host's normal
session lifecycle after collecting evidence.
`PROBE_OUTPUT` must be a new path: the probe reserves it with mode `0600` and
rejects existing files or symlinks before invoking the Gateway. The production
adapter probe waits up to 30 seconds for a valid tool-backed positive control
while transcript catch-up runs; it does not treat the initial page batch as a
complete index. Optional obsolete-frame cleanup occurs only after that scan.

Local production logs recorded a greeting with zero frames/reads/bytes in 10 ms,
and related/continuation turns with one frame and 5,365 bytes in 7-51 ms. These
observations came from the deployed stack including PR #387; they are not isolated
latency measurements of this branch. Likewise, the historical recall-only timings
in `historical-tool-recall.md` describe that projection, not semantic hydration.
Later stable-tool-schema and prompt-cache experiments must not be attributed to
this feature. A controlled end-to-end A/B on an identical session snapshot and a
held-out retrieval-quality corpus remain outstanding.

Validation on this isolated branch (2026-09-07): build and typecheck passed;
312 unit tests, 55 integration tests, and 4 probe-script tests passed, with zero skips. Plugin Inspector
passed with one dependency-install coverage gap; this is not a cold-install test.
The real configured daemon, using synthetic transcript-reader entries, returned:

| Query | Indexed score | Hydrated frames / reads | Context bytes | Hydration time |
| --- | ---: | ---: | ---: | ---: |
| hello | 0.414 | 0 / 0 | 0 | 0.12 ms |
| Why did the secure connection fail? | 0.838 | 1 / 1 | 1,610 | 1.38 ms |
| What repaired our encrypted client connection? | 0.812 | 1 / 1 | 1,610 | 2.53 ms |

The adapter was recreated between indexing and retrieval. Both positive queries
recovered the certificate-expiration evidence; synthetic records were deleted
afterward. These are single adapter measurements with a real daemon and a fake
transcript reader, not Gateway or model response times.

Review corrections: the terminal-content regression failed on `dfde6a1` with
`Cannot read properties of undefined (reading 'some')`. Non-array terminal
content now leaves the unresolved exchange intact instead of throwing; valid
final-text projection and live-tool preservation remain covered. The old output
write reproduced mode `0644` on an existing file despite requesting `0600`.
Probe tests cover secure creation, existing-file/symlink rejection before a
Gateway call, delayed positive-control availability, deadlines, and RPC errors.
The transcript test also confirms that a frame beyond the initial 256-page
batch appears during background catch-up. No new production performance or
delivery result is claimed by these local regression tests.

Follow-up probe cancellation review: on `dd668d7`, the client forwarding test
observed missing options at `listCollection`, while the polling-sleep timeout
reported `AbortError` rather than the probe deadline. The probe now forwards its
signal to both collection and metadata RPCs; `listCollection` accepts optional
`CallOptions` like `listByMeta`. Deadline errors are consistent during reads and
sleep, and unrelated RPC errors still propagate unchanged. Tests verify option
forwarding and that a cooperative pending read receives cancellation. This is
diagnostic-probe cleanup, not a change to live hydration selection or a new
production crash finding.
