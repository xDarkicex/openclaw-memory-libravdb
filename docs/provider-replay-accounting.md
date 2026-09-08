# Provider replay accounting

Compaction pressure must describe the source projection returned to the host,
not the smaller normalized representation sent to daemon ingestion. Historical
tool results are deliberately excluded from ingestion, but may still be replayed.
Text, reasoning and tool-call arguments now contribute to the message estimate.
Cached compacted context contributes to predictive pressure; returned system
additions contribute to assembly estimates. A low or non-finite daemon estimate
cannot suppress the local estimate.

More accurate accounting can expose previously hidden overflow. When a
projection contains tool protocol, budget enforcement uses the existing
turn-aligned enforcer. It keeps the current user/call/result bundle together,
even if that bundle alone exceeds budget, and reports that pressure to the host
instead of dropping one side of the exchange.
An oversized projection with no user boundary is dropped as a whole; its system
addition is bounded separately. Under-budget tool-only inputs are unchanged.
Tool argument estimation uses the existing guarded block serializer; cyclic or
BigInt arguments do not throw from accounting or rewrite the source objects.

This change does not introduce an excerpt allowance, delete reasoning, classify
completed tasks, change daemon ingestion, or implement tool-result rehydration.
It is still a character-based estimate, not an exact model tokenizer. Image
tokens and host-added tool schemas are not newly modeled here. It does not claim
that all prompt-cache misses or slow greetings are fixed.

## Validation

`pnpm check` passed: plugin inspector PASS, 281 unit tests and 55 integration
tests, zero failures or skips. `pnpm build` passed. The three new regressions
fail on unpatched upstream and pass on the fix. In a synthetic zero-estimate
control, a 90,000-character result remains 90,000 characters and the same source
array is returned, while its transcript estimate is now 22,551 tokens rather
than zero. There is no evidence-excerpting policy in this patch.

Production has not been deployed with this branch. No after-fix production
latency reduction, automatic retrieval of old results, or Discord delivery
success is claimed by these test results.

## Reproduction and controls

The new tests in `test/unit/context-engine.test.ts` cover:

1. Reasoning, large tool arguments and results plus a system addition, with a
   zero/non-finite daemon estimate. The source array remains unchanged.
2. A completed research exchange with a large result, followed by a greeting.
   With reported usage zero, predictive compaction must still see the pressure.
3. An active tool exchange that exceeds budget by itself. It must not lose its
   result while retaining its call, or report that the exchange fits.
4. Cyclic and BigInt tool arguments: finite estimates and unchanged source data.
5. Oversized no-user tool-call, tool-result, and paired projections are bounded,
   while under-budget versions are preserved.

The first three fail against upstream `c3570e1` (v1.10.25). The baseline run uses the
new tests with only `src/context-engine.ts` replaced in the generated test build
by a transpilation of that commit's source. A fresh TypeScript build restores
the patched implementation before running the full tests.

Review regressions were tested against PR head `7db783f` before fixing it:
cyclic arguments threw `TypeError: Converting circular structure to JSON`, and
an oversized tool-result-only projection was returned intact. Both fail-before
tests pass after the review corrections. These are local adapter tests, not a
new live Gateway or model performance experiment.

## Anonymized incident evidence

A short greeting in an existing research session resulted in 101,450 processed
prompt tokens: 52,345 ms prompt evaluation versus 946 ms generation (71 tokens).
OpenClaw's interval from prompt submission to model completion was 57,301 ms, with no
new tool calls. Its usage fields were zero. This is evidence of replay pressure,
not proof that this patch reduces production latency to a particular target.

Stored history included 182,366 characters of prior tool results and 82,983
characters of reasoning. The system-prompt trace reported 64,669 characters.
The trajectory payload was truncated, so these are not an exact decomposition
of the backend token count. No raw conversations, identities, endpoints,
credentials, hostnames or absolute installation paths are included here.
