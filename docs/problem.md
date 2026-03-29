# The Problem This Plugin Solves

This plugin exists because the stock OpenClaw memory path is optimized for lightweight persistence, not for a full context lifecycle with scope separation, compaction, and bounded retrieval.

## What the Stock Plugin Is Good At

The default `memory-lancedb` style plugin is still a good fit when you want:

- a simple top-k semantic lookup over durable notes
- a low-complexity setup
- a heuristic capture model where the agent decides what to save
- no additional sidecar process

For short sessions and light persistent memory, that is often the right answer.

## Where the Stock Model Breaks Down

The workload this plugin targets is different:

- long technical sessions
- repeated workflow state that must not be lost
- user/session/global scopes that behave differently
- compaction instead of unbounded append-only growth
- retrieval that must fit within a prompt token budget

The failure modes are structural, not cosmetic.

### Context collapse in long sessions

A single-table top-k memory system has no first-class notion of ephemeral session state versus durable user memory. A long active session accumulates turns that are highly relevant right now but should not pollute long-term recall forever.

### No scope separation

This plugin uses distinct namespaces for:

- `session:<sessionId>`
- `turns:<userId>`
- `user:<userId>`
- `global`

Those scopes are not interchangeable. Session state needs different retention, different recency behavior, and different retrieval weighting than durable user memory.

### No token budget management

Retrieval is only half the problem. The selected memories must still fit inside a bounded prompt budget. This plugin treats ranking and packing as one pipeline, not as disconnected concerns.

### No automatic compaction

Raw turns are not the right long-term storage format. The plugin clusters session turns, summarizes them, removes source turns after confirmed summary insertion, and lets summary confidence affect later retrieval. Without compaction, memory becomes an append-only dump that eventually competes with itself.

## Why This Is a Lifecycle Replacement

The solution is not a different LanceDB parameter or a larger `topK`.

The plugin replaces the whole context lifecycle:

1. ingestion
2. gating and promotion
3. retrieval and ranking
4. token-budget fitting
5. compaction and summarization
6. quality feedback into future retrieval

That is why the plugin is a slot-level memory replacement instead of a helper library layered beside the stock plugin.
