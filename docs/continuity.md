# Continuity Model

This document defines the continuity layer for the planned memory system.
Its purpose is to ensure that session continuity does not depend only on
semantic retrieval quality or summary fidelity.

The central design rule is:

$$
\text{continuity} \neq \text{semantic summary alone}
$$

Instead, continuity is modeled as the composition of:

$$
C_{\mathrm{total}}(q)=\mathcal{I}\cup T_{\mathrm{recent}}\cup \mathrm{Proj}(\mathcal{V}_{\mathrm{rest}}, q)
$$

where:

- $\mathcal{I}$ is the invariant authored context from
  [`ast.md`](./ast.md)
- $T_{\mathrm{recent}}$ is a preserved raw recent session tail
- $\mathrm{Proj}(\mathcal{V}_{\mathrm{rest}}, q)$ is the scored retrieval
  output over the remaining variant memory corpus

## 1. Motivation

The retrieval system in [`mathematics-v2.md`](./mathematics-v2.md) is optimized
for relevance under a token budget. That is necessary, but it is not sufficient
for continuity.

Lossy summarization and imperfect retrieval can both preserve topic relevance
while still losing operational details such as:

- the latest local intent shift
- recently introduced identifiers and file paths
- nearby causal ordering between turns
- work-in-progress context that has not yet become durable memory

Therefore the system needs a non-semantic continuity term that remains stable
even when summary quality is imperfect.

## 2. Continuity Decomposition

Let the full retrievable corpus be partitioned as:

$$
\mathbf{D}=\mathcal{I}\cup\mathcal{V},
\qquad
\mathcal{I}\cap\mathcal{V}=\emptyset
$$

Following [`ast.md`](./ast.md), invariant authored directives are injected for
all queries:

$$
d\in\mathcal{I} \Rightarrow G(q,d)=1
$$

We further partition the session-derived variant corpus into:

$$
\mathcal{V} = T_{\mathrm{recent}} \cup \mathcal{V}_{\mathrm{rest}},
\qquad
T_{\mathrm{recent}} \cap \mathcal{V}_{\mathrm{rest}} = \emptyset
$$

where $T_{\mathrm{recent}}$ is a fixed raw suffix of the active session that is
preserved verbatim and excluded from destructive compaction.

The final injected context becomes:

$$
C_{\mathrm{total}}(q)=\mathcal{I}\cup T_{\mathrm{recent}}\cup \mathrm{Proj}(\mathcal{V}_{\mathrm{rest}}, q)
$$

This means continuity is guaranteed jointly by:

- authored invariants
- preserved recent raw context
- scored retrieval over the older compacted/searchable corpus

## 3. Recent-Tail Definition

Let the active session turns ordered by ascending timestamp be:

$$
\Sigma = \langle t_1, t_2, \dots, t_n \rangle
$$

Define a preserved recent-tail selector:

$$
T_{\mathrm{recent}} = \mathrm{Tail}(\Sigma; m, \tau_{\mathrm{tail}})
$$

subject to the constraints:

- at least the most recent $m$ raw turns are preserved
- the preserved tail token cost does not exceed $\tau_{\mathrm{tail}}$
- preserved turns are never replaced by summaries while they remain in the tail

The exact selection policy may be count-based, token-based, or both. A valid
runtime policy is:

$$
T_{\mathrm{recent}} = \text{longest raw suffix satisfying }
|T_{\mathrm{recent}}| \ge m
\text{ and }
\sum_{d\in T_{\mathrm{recent}}}\mathrm{toks}(d)\le \tau_{\mathrm{tail}}
$$

This suffix is intentionally structural rather than semantic.

The selector should also preserve small logically coupled turn bundles when a
boundary would otherwise split an inseparable local unit. In practice, this
means the runtime may extend $T_{\mathrm{recent}}$ slightly backward to keep a
recent cause/effect pair, request/response pair, or equivalent tightly coupled
artifact bundle intact.

## 4. Budget Partition

Let the total prompt budget be $\tau$. Then the continuity-aware allocation is:

$$
\tau = \tau_{\mathcal{I}} + \tau_{\mathrm{tail}} + \tau_{\mathcal{V}}
$$

with:

- $\tau_{\mathcal{I}}$ reserved for invariant authored context
- $\tau_{\mathrm{tail}}$ reserved for preserved recent raw context
- $\tau_{\mathcal{V}}$ reserved for scored retrieval over
  $\mathcal{V}_{\mathrm{rest}}$

Startup and runtime must preserve:

$$
\tau_{\mathcal{I}} + \tau_{\mathrm{tail}} \le \tau
$$

and:

$$
\sum_{d\in C_{\mathrm{total}}(q)} \mathrm{toks}(d)\le \tau
$$

The retrieval system may truncate only $\mathrm{Proj}(\mathcal{V}_{\mathrm{rest}}, q)$.
It must not truncate $\mathcal{I}$, and it must not silently compact away
$T_{\mathrm{recent}}$.

## 5. Compaction Boundary Invariant

Compaction operates only on:

$$
\mathcal{V}_{\mathrm{rest}}
$$

not on $T_{\mathrm{recent}}$.

If a summary record $s(C_j)$ replaces a cluster $C_j$, then:

$$
C_j \subseteq \mathcal{V}_{\mathrm{rest}}
$$

and never:

$$
C_j \cap T_{\mathrm{recent}} \neq \emptyset
$$

This gives a hard continuity boundary: recent discourse remains exact, older
discourse becomes summary-eligible.

The boundary must also be bundle-safe. If a cluster candidate would split a
tightly coupled local unit across the tail boundary, the runtime should move the
boundary backward so that the unit stays entirely in $T_{\mathrm{recent}}$ or
entirely in $\mathcal{V}_{\mathrm{rest}}$.

## 6. Compaction Progress Guarantee

Continuity is not preserved if compaction can stall indefinitely or emit
summaries that fail to reduce storage pressure. Therefore compaction must make
monotone progress when it is invoked on eligible material.

Let $C_j$ be a compactable cluster with source token mass:

$$
\tau(C_j)=\sum_{d\in C_j}\mathrm{toks}(d)
$$

and let the emitted summary be $s(C_j)$ with:

$$
\tau(s(C_j))=\mathrm{toks}(s(C_j))
$$

The preferred invariant is:

$$
\tau(s(C_j)) < \tau(C_j)
$$

If the primary summarizer fails to achieve this reduction, the compaction path
should escalate through increasingly conservative modes until it produces a
strictly smaller representation or explicitly declines compaction for that
cluster. A valid strategy is:

1. normal summary generation
2. more aggressive summary generation
3. deterministic bounded fallback

This preserves a stronger system property:

$$
\Delta_{\mathrm{compact}}(C_j)=\tau(C_j)-\tau(s(C_j)) > 0
$$

whenever a cluster is actually replaced.

## 7. Summary Lineage And Recoverability

Continuity improves when summary nodes are not opaque replacements but
recoverable abstractions with stable lineage.

For each compacted cluster $C_j$, the summary metadata should include at least:

- source identifiers
- earliest source timestamp
- latest source timestamp
- compaction timestamp
- summary method
- confidence

If deeper summary-on-summary compaction is introduced later, the runtime should
extend this metadata with parent-summary references so the compacted memory
space remains navigable as a directed acyclic lineage graph rather than a flat
bag of summaries.

Formally, for each summary node $s$ we want a lineage map:

$$
L(s)=\{\mathrm{SourceIDs}(s), t_{\min}(s), t_{\max}(s), \mathrm{Method}(s), \mathrm{Confidence}(s)\}
$$

and potentially, in a hierarchical future:

$$
P(s)\subseteq \mathbf{S}
$$

where $\mathbf{S}$ is the set of summary nodes.

This does not replace retrieval scoring. It guarantees that compressed history
remains inspectable and attributable.

## 8. Continuity-Aware Summarization Input

Compaction input should be continuity-safe before it reaches the summarizer.
Large opaque payloads, binary blobs, and transport artifacts consume token
budget without increasing continuity.

Therefore the summarization view of a cluster should apply a sanitization
operator:

$$
\widetilde{C}_j=\mathrm{Sanitize}(C_j)
$$

where $\mathrm{Sanitize}$ removes or replaces payload forms whose contribution
to downstream continuity is negligible relative to their token mass.

The intended behavior is not to destroy source truth in storage. It is to
provide the summarizer with a continuity-preserving projection of the source
cluster.

## 9. Delta-Conditioned Summaries

Independent summaries tend to repeat stable background context and waste both
storage and retrieval budget. A stronger continuity formulation conditions new
summaries on nearby previously compacted state.

Let $B_j$ be bounded prior compacted context relevant to cluster $C_j$. Then a
delta-conditioned summarizer computes:

$$
s(C_j \mid B_j)
$$

instead of an unconditional $s(C_j)$.

The purpose is to preserve what changed, what remains active, and what was
superseded, rather than re-summarizing unchanged context repeatedly.

This should remain bounded. $B_j$ is supporting context for compaction, not an
unbounded recursive history expansion.

## 10. Why This Complements Retrieval

The retrieval score in [`mathematics-v2.md`](./mathematics-v2.md) answers:

$$
\text{which older records are most relevant to query } q\ ?
$$

The continuity term answers a different question:

$$
\text{which context must remain exact even if scoring or summarization is imperfect?}
$$

These objectives are complementary, not competing.

The continuity layer is therefore a hard constraint system wrapped around the
existing ranking model, not a replacement for it.

## 11. Runtime Invariants

The implementation must preserve the following:

1. Invariant completeness:

$$
\forall d\in\mathcal{I},\ \forall q\in\mathbf{Q}: d\in C_{\mathrm{total}}(q)
$$

2. Recent-tail exactness:

$$
\forall d\in T_{\mathrm{recent}}:\ d \text{ is stored and injected as raw context, not as a derived summary}
$$

3. Partition integrity:

$$
\mathcal{I}\cap T_{\mathrm{recent}}=\emptyset,\qquad
T_{\mathrm{recent}}\cap\mathcal{V}_{\mathrm{rest}}=\emptyset
$$

4. Compaction exclusion:

$$
\forall C_j,\ C_j \subseteq \mathcal{V}_{\mathrm{rest}}
$$

5. Budget respect:

$$
\sum_{d\in C_{\mathrm{total}}(q)} \mathrm{toks}(d)\le\tau
$$

6. Positive compaction progress on replaced clusters:

$$
\forall C_j \text{ actually replaced},\ \Delta_{\mathrm{compact}}(C_j) > 0
$$

7. Lineage completeness for summaries:

$$
\forall s,\ \mathrm{SourceIDs}(s)\neq\emptyset
$$

8. Boundary-safe coupling:

No continuity-critical local bundle may be split across the recent-tail and
compaction boundary.

## 12. Practical Interpretation

In practical terms, continuity for this system is:

$$
\begin{aligned}
\text{continuity} ={}& \text{authored rules} \\
&+ \text{recent exact session state} \\
&+ \text{recoverable compacted history} \\
&+ \text{older retrieved memory}
\end{aligned}
$$

This avoids the failure mode where continuity depends entirely on a semantic
summary being perfect. It also means compaction is not merely a storage
optimization. It is a constrained transformation that must preserve exact
recent state, recoverable lineage, and monotone progress.
