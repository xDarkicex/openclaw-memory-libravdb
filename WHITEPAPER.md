# LibraVDB: A Persistent Memory Architecture for Long-Horizon AI Sessions

**Status:** Active development — v1 shipped, v2 in progress  
**Repository:** OpenClaw plugin + Go sidecar daemon  

---

## Abstract

AI assistants forget. Every session starts cold, every context window has a hard token ceiling, and standard retrieval-augmented systems treat memory as a flat similarity problem — the most semantically similar chunk wins, regardless of whether it is a behavioral rule, a fleeting remark, or yesterday's critical architectural decision.

LibraVDB is an embedded memory system designed for long-horizon AI sessions. It partitions memory into structured tiers based on authorial intent and informational value, applies a domain-adaptive gate to decide what is worth remembering, and guarantees that continuity does not depend on summarization being perfect. The result is a system that keeps the right context in the prompt without blowing the token budget, degrades gracefully under failure, and never silently destroys what the author declared invariant.

---

## Problem Statement

### Why existing solutions fall short

General-purpose vector databases (Pinecone, Chroma, Qdrant) treat all memory as a single undifferentiated retrieval pool. That works for document search. It breaks for conversational memory, where:

- **Behavioral rules must always appear** — a user's "never answer in prose" constraint is not optional recall; it is a hard invariant that must survive every compaction pass.
- **Recency has asymmetric value** — the last three turns of a session contain work-in-progress context that no semantic similarity score can fully recover once it is compressed.
- **Technical sessions violate conversational memory assumptions** — repeated file paths, error signatures, and architectural decisions are not noise. They are the working set. Novelty-based filters that penalize repetition will silently discard exactly what a developer needs remembered.
- **Confidence signals lie** — a summarizer can produce a fluent, internally consistent summary that points in the wrong direction in the retrieval geometry. Trusting decoder confidence alone produces memories that read well but retrieve badly.

None of these problems are solved by choosing a different similarity metric or adding metadata filters. They require a fundamentally different memory architecture.

---

## Design Goals

- **Local ONNX runtime with hardware acceleration support** — the embedding and summarization pipeline runs as an embedded binary and can use the runtime's available acceleration backend
- **Single-process sidecar** — memory is managed by a Go daemon that the host plugin supervises; no cloud dependency, no network egress of session content
- **Deterministic recall guarantees** — certain classes of content are injected unconditionally, independent of query similarity scores
- **Bounded token usage** — every memory tier has a hard budget fraction; the system cannot silently overflow the host context window
- **Graceful degradation** — every failure path is defined; a dead daemon means no memory augmentation, not a crashed session
- **Domain-aware ingestion** — the admission gate distinguishes technical working sessions from conversational ones and scores them accordingly

---

## Architecture

The system consists of two layers: a TypeScript plugin that runs inside the host AI process, and a Go sidecar daemon that owns storage, embedding, and summarization.

```
Host process (TypeScript)
  ├── Context engine          ingest / assemble / compact
  ├── Memory prompt section   static header injection
  └── Plugin runtime          lazy daemon connect + RPC client
           │
           │  JSON-RPC over Unix socket (TCP on Windows)
           ▼
Sidecar daemon (Go)
  ├── ONNX embedding engine   Nomic embed-text-v1.5
  ├── Extractive summarizer   always available
  ├── Optional T5 summarizer  ONNX, abstractive
  ├── Optional Ollama route   external abstractive endpoint
  └── LibraVDB store
        ├── session:<id>      per-session turns and summaries
        ├── turns:<userId>    raw repetition-measurement store
        ├── user:<userId>     durable promoted memories
        ├── global            shared cross-session context
        └── elevated:<scope>  protected shadow-rule records
```

### Data flow in three phases

**Ingest.** Every user turn is written to the session store immediately. A domain-adaptive scalar then scores the turn for durable promotion. Turns that clear the threshold are written into the user's durable namespace with full scoring metadata. Session writes are fire-and-forget; durable promotion failures do not surface to the user.

**Assemble.** On each query, the context engine retrieves candidates from session, durable, and global memory in parallel, applies a hybrid ranker, and packs the result into the available token budget. Authored invariants are injected unconditionally before any retrieval result. The recent session tail is preserved verbatim. The engine falls back to the unmodified message list if the sidecar is unreachable.

**Compact.** When session memory exceeds a configurable threshold, the engine clusters eligible turns chronologically and routes each cluster to extractive or abstractive summarization. Summaries are scored in the same embedding space used for retrieval; clusters that drift too far from their source are rejected and re-run extractively. Source turns are deleted only after the summary is durably written.

---

## System Properties

### Memory tier hierarchy

The system maintains five tiers with strictly ordered injection priority:

| Tier | Name | Injection guarantee |
|---|---|---|
| 1 | Hard authored invariants | Unconditional — always in every prompt |
| 1.5 | Elevated guidance | Admitted when structurally protected during compaction and query-relevant |
| 2 | Soft authored invariants | Position-preserving prefix selection under a reserved token budget |
| 3 | Recent raw tail | Verbatim — compaction is forbidden to touch this window |
| 4 | Recalled variant memory | Best-effort semantic retrieval over the remaining budget |

Higher tiers can starve lower tiers. Tier 4 is evicted before Tier 3. Tier 2 is truncated before the mandatory tail minimum is broken. The token budget is never silently exceeded.

### Authored invariant extraction

Markdown documents loaded as agent instructions are parsed into an Abstract Syntax Tree. Nodes are classified into three partitions using structural kind and a zero-allocation deontic lexer: hard directives (lists, YAML frontmatter), soft directives (blockquotes and detected imperative paragraphs), and variant lore. The partition is deterministic and cached against a content hash; re-parsing on every turn is not required.

The deontic lexer detects second-person imperative and prohibitive surface forms ("you must", "never", etc.) in paragraph nodes and promotes matching paragraphs to Tier 2, preventing behavioral rules written as prose from being buried in the semantic retrieval pool.

### Domain-adaptive ingestion gate

The admission scalar that controls durable promotion is a continuous convex mixture of two sub-scorers: a conversational branch that rewards novelty, measures repetition against existing memory, and detects natural-language structural load; and a technical branch that rewards concrete artifact density (file paths, error codes, API endpoints, architectural decisions) normalized by turn length.

A domain detector continuously measures the technical density of each turn and smoothly interpolates between the two branches. There is no binary mode switch; a mixed turn receives a blended score. The scalar is guaranteed to stay in [0, 1] regardless of weighting, and six formal invariants are verified by the test suite — including the properties that an empty memory always returns maximum novelty, that memory saturation always vetoes the repetition reward, and that purely conversational turns collapse to the conversational branch exactly.

This design means repeated file paths and error signatures score highly in the technical branch even though they would score low under a novelty-only conversational model.

### Hybrid retrieval ranking

Retrieved candidates are ranked by a weighted combination of semantic similarity, recency decay, and scope preference. Recency uses scope-specific exponential decay constants calibrated to natural half-lives: session memory fades on the order of hours, durable user memory on the order of a day, and global memory on the order of days. Summary candidates carry an additional quality multiplier derived from their compaction confidence score, so low-confidence summaries compete less aggressively than high-confidence ones.

The ranker is a convex combination with re-normalized weights, ensuring scores remain on a stable [0, 1] scale regardless of configuration.

### Compaction confidence grounded in retrieval geometry

Previous versions evaluated summarizer confidence using decoder log-probability alone. A fluent summary is not the same as a faithful one, and decoder confidence does not measure faithfulness in the embedding space the retrieval layer actually uses.

The current design evaluates every abstractive summary in Nomic embedding space before accepting it, measuring both semantic alignment to the cluster centroid and coverage of individual source turns. Summaries that fall below a geometric preservation threshold are rejected and re-run extractively. The confidence signal reported downstream is a weighted combination of Nomic-space preservation and decoder confidence, biased toward the geometric measure.

Evaluation against 17 clusters (5 normal, 12 adversarial) showed the new confidence signal to be strictly more retrieval-aware, with the largest rescues on cross-domain and threshold-heavy clusters that decoder confidence had pessimistically undervalued.

---

### Continuity guarantee

Semantic retrieval quality can degrade without warning — a compaction pass can produce a plausible-sounding summary that loses an identifier, a causal ordering, or a recent intent shift. The system guards against this with a structural continuity layer that is independent of summarization quality.

The context assembly law guarantees:

- Hard authored invariants appear in every prompt, regardless of relevance scoring
- A minimum raw recent tail is preserved verbatim and cannot be replaced by summaries while it remains in the window
- Compaction operates only outside the recent tail boundary
- The total assembled context never exceeds the declared token budget

These are runtime invariants checked on every assembly call, not aspirational properties. The system is designed so that partial degradation (one tier failing) leaves the remaining tiers intact.

### Elevated guidance (Tier 1.5)

Some high-value guidance surfaces in session turns rather than authored documents — architectural decisions made mid-session, behavioral constraints established conversationally. These are too weakly structured for AST promotion to Tier 1 or 2, but too directive to be left to decay through summarization or compete on semantic similarity alone.

During compaction, turns with detected deontic surface signals and sufficient source stability are extracted as protected shards before the cluster is summarized. These shards are persisted to a dedicated elevated namespace and admitted at retrieval time when they are semantically relevant to the current query. They outrank ordinary recalled memory but do not claim the full normative force of authored invariants.

The protection decision is deterministic-first. A local embedding model can boost borderline candidates, but model failure does not open the deletion path. If the abstractive model times out, protected shards survive verbatim and only the compressible remainder of the cluster is affected.

---

## Benchmarks

Compaction evaluation was run against a 17-cluster corpus using real local models (Nomic embed-text-v1.5, ONNX T5-small).

**Confidence improvement over T5-only baseline:**

| Cluster type | Median delta |
|---|---:|
| Normal engineering memory | +0.04 |
| Adversarial (cross-domain, threshold-heavy) | +0.12 |
| Adversarial (conflicting signals) | −0.03 |

The largest single improvement was a cross-domain cluster where T5 raw confidence was 0.52 and the Nomic-grounded hybrid score was 0.72 — a case where the decoder found the summary internally coherent but the retrieval geometry showed significant drift from source.

A threshold sweep across the preservation gate showed that the adversarial corpus successfully differentiates stronger and weaker summaries at tighter settings — the two cases that begin to stress geometric drift are the compaction-boundary cluster and the cross-domain mix cluster, which are exactly the cases designed to challenge abstractive faithfulness. The shipped threshold is conservative; the gate machinery is exercised by unit tests against synthetic inputs even when the real-model corpus does not force a fallback trip.

---

## Failure Modes and Degradation Policy

| Failure | Behavior | User impact |
|---|---|---|
| Sidecar unavailable | Plugin registers but that hook returns original messages | No memory augmentation for that turn |
| Daemon connection lost mid-session | Exponential backoff, then degraded mode | Memory unavailable until reconnect |
| Assemble RPC failure | Returns original message list unchanged | That turn gets no recall augmentation |
| Ingest gate failure | Session write already committed; durable write skipped | Session memory survives; durable memory may miss one turn |
| Abstractive summarizer unavailable | Extractive path used unconditionally | Compaction still runs; summary quality may be lower |
| Disk full | Error logged; new records not stored | Existing memory intact; new writes fail silently |

No failure path crashes the host session. Every degraded mode has a defined output: either the original messages, or a partial augmentation, or a static header with no RPC dependency.

---

## Roadmap

**Shipped (v1):**
- Persistent session and durable user memory
- Domain-adaptive ingestion gate
- Extractive + optional T5 abstractive compaction
- Nomic-space compaction confidence
- Multi-tier context assembly with budget enforcement
- Tier 1.5 elevated guidance (protected shard compaction)

**In progress (v2):**
- Immutable raw turn store with summary-coverage DAG (lossless compaction extension)
- Delta-conditioned summarization (new summaries conditioned on adjacent compacted state)
- Temporal-compositional query mode (coverage-aware anchor retrieval for multi-step queries)
- Calibrated gate thresholds via isotonic regression on usefulness labels

**Future:**
- Hot-spot preservation tiers based on access concentration
- Entropy-driven tail selection
- Rate-distortion views of compaction quality

---

## Summary

LibraVDB is not a retrieval-augmented generation wrapper. It is a memory architecture that treats authorial intent, session continuity, and informational value as first-class system properties rather than retrieval tuning knobs. The core invariants — hard injection, tail preservation, compaction boundary safety, and budget respect — are structural guarantees, not best-effort heuristics. The domain-adaptive gate, Nomic-grounded compaction confidence, and elevated-guidance tier are the novel contributions that make those guarantees useful in practice.
