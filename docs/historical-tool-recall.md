# Opt-in historical evidence recall

Set `historicalToolReplay` to `"recall"` in the memory plugin configuration.
The default remains `"full"` for compatibility.

Recall mode separates conversation continuity from historical tool payloads.
After a later user message, a turn ending in an explicit successful final
answer may omit its balanced tool-call/result exchanges and thinking blocks
from provider replay. User messages and final answers remain. Current turns,
unmatched tool protocols, interrupted answers, and excluded sessions stay
unchanged. The projection does not edit stored transcripts or ingestion.
All assembly returns, including daemon-error fallbacks, use this policy.

Relevant older facts continue to come from the existing query-driven memory
assembly and memory tools. This is not a new semantic similarity classifier:
it does not automatically reload entire historical tool results for related
queries. Exact omitted evidence may require a fresh tool call or an authorized
transcript lookup; memory summaries alone cannot guarantee verbatim recovery.
If memory is unavailable, old evidence is unavailable to the model unless
retrieved again. Do not infer missing details from a final-answer summary.

The operation is linear in transcript size, uses no additional model/RPC call,
and leaves source indices used by compaction snapshots unchanged. Disabling
the option restores full replay from stored history on subsequent assembly.
No OpenClaw core changes are required.

Validation: unit controls cover matched historical exchanges, live results,
unmatched IDs, missing results, failed final answers, idempotence, immutable
input, retained recall injection, and daemon-error fallback. A read-only replay
of an affected production transcript reduced serialized history from 325,592
to 25,932 characters (56 to 36 messages), omitting 12 completed tool results
and 83,195 thinking characters. These are transcript measurements, not wire
token counts or end-to-end latency guarantees.

Production Gateway validation after archive installation and restart:

| Case | Gateway duration | Backend prefill | Backend input processed |
| --- | ---: | ---: | ---: |
| Previous greeting (before rescue) | 45.08s submitted-to-completed | 40.33s | 102,720 |
| First rescued greeting | 12.932s agent duration | 8.59s | 29,305 |
| Repeat greeting | 1.554s agent duration | 0.453s | 113 uncached tokens |

The repeat retained a roughly 29k-token context; 113 is incremental prefill,
not total context. Both greetings returned useful final text without tools.
These were no-delivery Gateway turns using the affected Discord session, not
Discord inbound/outbound transport measurements. Cold performance still
exceeds a five-second target. Base instructions and recall injection remain;
the rescue does not claim to solve every remaining latency source.

A subsequent Gateway request to look up prior response-latency work invoked
`libravdb_memory_search` through `tool_call`, completed in two assistant turns,
and returned a final answer without repetition (24.595s). This confirms the
live tool-continuation path, not a general sub-five-second tool latency claim.
Validation passed 281 unit tests and 55 integration tests with no skips.
