# Continuity Model

This document defines the continuity layer for the planned memory system.
Its purpose is to ensure that session continuity does not depend only on
semantic retrieval quality or summary fidelity.

The central design rule is:

$$
\text{continuity} \neq \text{semantic summary alone}
$$

This document also defines a proposed lossless extension to the current model.
That extension is inspired by the immutable-store and expandable-summary
architecture in the LCM paper, "Lossless Context Management"
([Ehrlich and Blackman, 2026](https://papers.voltropy.com/LCM)). Where this
document adopts that idea directly, it cites the paper explicitly. The
mathematical notation below is adapted to this repository's existing
invariant/tail/retrieval decomposition rather than copied from the paper.

Instead, continuity is modeled as the composition of:

$$
C_{\mathrm{total}}(q)=\mathcal{I}_1\cup \mathcal{I}_2^{*}\cup T_{\mathrm{recent}}\cup \mathrm{Proj}(\mathcal{V}_{\mathrm{rest}}, q)
$$

where:

- $\mathcal{I}_1$ is the hard authored invariant context from
  [`ast-v2.md`](./ast-v2.md)
- $\mathcal{I}_2^{*}$ is the admitted soft-invariant prefix from
  [`ast-v2.md`](./ast-v2.md)
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
\mathbf{D}=\mathcal{I}_1\cup\mathcal{I}_2\cup\mathcal{V},
\qquad
\mathcal{I}_1\cap\mathcal{I}_2=\mathcal{I}_1\cap\mathcal{V}=\mathcal{I}_2\cap\mathcal{V}=\emptyset
$$

Following [`ast-v2.md`](./ast-v2.md), invariant authored directives are injected for
all queries:

$$
d\in\mathcal{I}_1 \Rightarrow G(q,d)=1
$$

Soft authored directives are injected by position-preserving prefix selection:

$$
\mathcal{I}_2^{*}=\mathrm{Pref}(\mathcal{I}_2;\,\tau_{\mathcal{I}_2}^{\mathrm{eff}})
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
C_{\mathrm{total}}(q)=\mathcal{I}_1\cup \mathcal{I}_2^{*}\cup T_{\mathrm{recent}}\cup \mathrm{Proj}(\mathcal{V}_{\mathrm{rest}}, q)
$$

This means continuity is guaranteed jointly by:

- hard authored invariants
- admitted soft authored invariants
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
- the preserved tail token target is $\tau_{\mathrm{tail}}$
- preserved turns are never replaced by summaries while they remain in the tail

The exact selection policy may be count-based, token-based, or both. A valid
runtime policy is:

$$
T_{\mathrm{base}} = \text{shortest raw suffix of } \Sigma \text{ such that }
|T_{\mathrm{base}}| \ge m
$$

If the base suffix fits within the tail token target:

$$
\sum_{d\in T_{\mathrm{base}}}\mathrm{toks}(d)\le \tau_{\mathrm{tail}}
$$

then the runtime may extend it backward to the longest raw suffix
$T_{\mathrm{recent}}$ satisfying:

$$
T_{\mathrm{base}} \subseteq T_{\mathrm{recent}}
\qquad\text{and}\qquad
\sum_{d\in T_{\mathrm{recent}}}\mathrm{toks}(d)\le \tau_{\mathrm{tail}}
$$

If the most recent $m$ turns already exceed the tail target:

$$
\sum_{d\in T_{\mathrm{base}}}\mathrm{toks}(d) > \tau_{\mathrm{tail}}
$$

then continuity takes precedence and:

$$
T_{\mathrm{recent}} = T_{\mathrm{base}}
$$

with the overflow absorbed by reducing the retrievable variant budget
accordingly. In other words, $m$ wins over $\tau_{\mathrm{tail}}$ whenever the
two conflict.

This selector is intentionally structural rather than semantic.

The selector should also preserve small logically coupled turn bundles when a
boundary would otherwise split an inseparable local unit. In practice, this
means the runtime may extend $T_{\mathrm{recent}}$ slightly backward to keep a
recent cause/effect pair, request/response pair, or equivalent tightly coupled
artifact bundle intact.

**Policy note.** Bundle coupling is a heuristic policy layer, not a formal
theorem term. It is listed in Section 13.4 as a heuristic and is not part of
the core $C_{\mathrm{total}}(q)$ assembly theorem.

## 4. Budget Partition

Let the total prompt budget be $\tau$. Then the continuity-aware allocation is:

$$
\tau = \tau_{\mathcal{I}_1} + \tau_{\mathcal{I}_2}^{*} + \tau_{\mathrm{tail}} + \tau_{\mathcal{V}}
$$

equivalently:

$$
\tau_{\mathcal{V}} = \tau - \tau_{\mathcal{I}_1} - \tau_{\mathcal{I}_2}^{*} - \tau_{\mathrm{tail}}
$$

with:

- $\tau_{\mathcal{I}_1}$ consumed by hard authored context
- $\tau_{\mathcal{I}_2}^{*}$ consumed by the admitted soft-invariant prefix
- $\tau_{\mathrm{tail}}$ reserved for preserved recent raw context
- $\tau_{\mathcal{V}}$ reserved for scored retrieval over
  $\mathcal{V}_{\mathrm{rest}}$

Following the unified contract in [`mathematics-v2.md`](./mathematics-v2.md),
let the reserve fractions satisfy:

$$
\alpha_1,\alpha_2,\beta\in[0,1],
\qquad
\alpha_1+\alpha_2+\beta\le 1
$$

with:

$$
\tau_{\mathcal{I}_1}\le \alpha_1\tau
\qquad\text{and}\qquad
\tau_{\mathrm{tail}}^{\mathrm{target}}=\beta\tau
$$

The soft authored tier is then bounded by:

$$
\tau_{\mathcal{I}_2}^{\mathrm{eff}}
=
\min\!\left(
\alpha_2\tau,\,
\tau-\tau_{\mathcal{I}_1}-\sum_{d\in T_{\mathrm{base}}}\mathrm{toks}(d)
\right)
$$

This enforces the intended precedence:

1. hard authored invariants
2. the mandatory recent-tail base suffix
3. the soft-invariant prefix
4. additional tail extension up to the target tail budget
5. residual variant retrieval

The residual budget must satisfy:

$$
\tau_{\mathcal{V}} \ge 0
$$

Startup and runtime must preserve:

$$
\tau_{\mathcal{I}_1} + \sum_{d\in T_{\mathrm{base}}}\mathrm{toks}(d) \le \tau
$$

and:

$$
\sum_{d\in C_{\mathrm{total}}(q)} \mathrm{toks}(d)\le \tau
$$

The retrieval system may truncate only $\mathrm{Proj}(\mathcal{V}_{\mathrm{rest}}, q)$.
It must not truncate $\mathcal{I}_1$, and it must not silently compact away
$T_{\mathrm{recent}}$. The soft authored tier may be truncated only by
position-preserving prefix selection.

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
*(This is a heuristic policy; see Section 13.4.)*

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

**Edge case — singleton clusters.** If a cluster contains only a single turn
($|C_j| = 1$), the clustering algorithm produces a `trivial`-tagged summary that
does not represent meaningful compaction progress. The $\Delta_{\mathrm{compact}} > 0$
guarantee applies only to clusters with $|C_j| \ge 2$ that are meaningfully replaced;
trivial singletons are boundary cases excluded from the progress invariant.

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

Formally, for each summary node $s$ we want a typed lineage record, and
potentially, in a hierarchical future:

$$
P(s)\subseteq \mathbf{S}
$$

where $\mathbf{S}$ is the set of summary nodes.

The object $L(s)$ is a typed tuple or record, not an unordered set. A more
precise notation is:

$$
L(s)=\big(\mathrm{SourceIDs}(s), t_{\min}(s), t_{\max}(s), \mathrm{Method}(s), \mathrm{Confidence}(s)\big)
$$

This does not replace retrieval scoring. It guarantees that compressed history
remains inspectable and attributable.

## 7.5 Lossless Recoverability Extension

The current implementation stores lineage metadata for summaries, but it does
not yet preserve a fully immutable raw session store after compaction. A
stronger continuity contract is to treat compaction summaries as derived views
over immutable raw history rather than destructive replacements. This is the
main architectural idea adopted from the LCM paper's immutable store, summary
DAG, and bounded expansion model
([Ehrlich and Blackman, 2026](https://papers.voltropy.com/LCM)).

Let the raw session history be:

$$
\mathcal{R}_{\mathrm{session}}=\langle r_1,r_2,\dots,r_n\rangle
$$

where each $r_i$ is a raw persisted turn and raw-history persistence is
append-only:

$$
\mathrm{Compact}(\mathcal{R}_{\mathrm{session}})=\mathcal{R}_{\mathrm{session}}
$$

Compaction instead constructs a summary-node set:

$$
\mathbf{S}=\{s_1,s_2,\dots\}
$$

and a parent relation:

$$
E_{\triangleleft}\subseteq (\mathbf{S}\times\mathbf{S})\cup(\mathbf{S}\times\mathcal{R}_{\mathrm{session}})
$$

where an edge $(s,x)\in E_{\triangleleft}$ means summary node $s$ directly
covers child node $x$, with $x$ either a raw turn or a lower-order summary.

The resulting continuity graph is:

$$
\mathcal{G}_{\mathrm{cont}}=(\mathbf{S}\cup\mathcal{R}_{\mathrm{session}}, E_{\triangleleft})
$$

with the intended acyclicity invariant:

$$
\mathcal{G}_{\mathrm{cont}} \text{ is a DAG}
$$

Define recursive expansion to leaf raw turns:

$$
\mathrm{Expand}^{*}(x)=
\begin{cases}
\{x\} & \text{if } x\in\mathcal{R}_{\mathrm{session}} \\
\bigcup_{y:(x,y)\in E_{\triangleleft}} \mathrm{Expand}^{*}(y) & \text{if } x\in\mathbf{S}
\end{cases}
$$

Then lossless recoverability means:

$$
\forall s\in\mathbf{S},\ \mathrm{Expand}^{*}(s)\neq\emptyset
$$

and:

$$
\forall r\in\mathcal{R}_{\mathrm{session}},\ \exists x\in \mathbf{S}\cup T_{\mathrm{recent}} \text{ such that } r\in \mathrm{Expand}^{*}(x)
$$

Operationally, this means compaction may change which nodes are injected or
searched first, but it must not erase the ability to navigate back to the raw
turns covered by a summary.

The current repository should treat this as a proposed extension, not as a
claim about present behavior. Today the compactor inserts summaries with
structured lineage metadata, then deletes the covered source turns from the
session collection after successful replacement. A future lossless
implementation should separate:

- immutable raw turn storage
- active/searchable summary views
- bounded expansion and search over compacted history

The corresponding data-model change is to add a raw immutable session layer and
store summary coverage edges explicitly instead of using lineage metadata alone
as the recoverability surface.

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

Let $B_j$ be bounded prior compacted context relevant to cluster $C_j$. A valid
selection rule is that $B_j$ is drawn from temporally adjacent or topically
adjacent compacted state and satisfies a fixed supporting-context cap:

$$
\mathrm{toks}(B_j)\le \tau_B
$$

for some configured constant $\tau_B$.

Then a delta-conditioned summarizer computes:

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
\mathcal{I}\cap\mathcal{V}_{\mathrm{rest}}=\emptyset,\qquad
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

9. Lossless recoverability when the extension is enabled:

$$
\forall s\in\mathbf{S},\ \mathrm{Expand}^{*}(s)\subseteq\mathcal{R}_{\mathrm{session}}
\qquad\text{and}\qquad
\mathrm{Expand}^{*}(s)\neq\emptyset
$$

10. Raw-history immutability when the extension is enabled:

Compaction may add summary nodes and coverage edges, but it must not delete
raw turns from $\mathcal{R}_{\mathrm{session}}$.

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

## 13. Layer Separation And Review Guidance

The strongest follow-on review result for this document is that the continuity
theory is healthiest when it keeps three layers separate:

1. storage axioms
2. core retrieval and assembly math
3. recoverability policy

The authoritative continuity contract in this document should therefore be read
as follows.

### 13.1 Storage Axioms

When the lossless extension is enabled, raw-history immutability is a storage
axiom:

$$
\mathrm{Compact}(\mathcal{R}_{\mathrm{session}})=\mathcal{R}_{\mathrm{session}}
$$

That statement is unconditional. It does not depend on query relevance,
summary confidence, or token budget. It is stronger than lineage metadata or
query-time expansion. It simply means compaction does not delete raw source
turns from the immutable raw layer.

### 13.2 Recoverability Theorem

The summary-coverage DAG and $\mathrm{Expand}^{*}$ belong to recoverability,
not to the primary retrieval theorem. Their job is to guarantee that compacted
history remains navigable back to raw source turns:

$$
\forall s\in\mathbf{S},\ \mathrm{Expand}^{*}(s)\subseteq\mathcal{R}_{\mathrm{session}}
\qquad\text{and}\qquad
\mathrm{Expand}^{*}(s)\neq\emptyset
$$

This is a structural property of the continuity graph. It is not by itself a
claim that every query should traverse that graph during normal assembly.

### 13.3 Retrieval Boundary

The core continuity theorem remains:

$$
C_{\mathrm{total}}(q)=\mathcal{I}_1\cup \mathcal{I}_2^{*}\cup T_{\mathrm{recent}}\cup \mathrm{Proj}(\mathcal{V}_{\mathrm{rest}}, q)
$$

This document treats that expression as the primary assembly law. A runtime may
experiment with query-time summary expansion, but such expansion should be
treated as a bounded policy layer wrapped around the core theorem unless it is
formally re-derived inside the governing retrieval math.

In particular, policy knobs such as:

- summary-expansion confidence thresholds
- expansion token budgets
- depth limits
- expansion penalties or attenuations

are not themselves continuity axioms. They are deployment and retrieval-policy
choices layered on top of the structural guarantees above.

### 13.4 Heuristic vs. Theorem Boundary

The following ideas remain useful, but should be read as heuristics unless
their mathematics is defined explicitly elsewhere:

- **bundle-safe boundary extension** (Section 3): the runtime may extend
  $T_{\mathrm{recent}}$ backward to avoid splitting a coupled local bundle;
  this is a heuristic policy, not a formal tail selector term
- specific escalation ladders for compaction fallback
- **confidence-triggered automatic expansion**: query-time summary expansion is
  explicit recovery/audit only; it was removed from the hot retrieval path and
  is not the default behavior — see Section 13.3 and memory 283
- any fixed expansion penalty not derived from the governing score equations

This distinction matters because continuity should stay theorem-safe even when
those policies are tuned, replaced, or disabled.

### 13.5 Future Theory Direction

Several mathematically interesting review suggestions are worth preserving for
future refinement, but they are not part of the current authoritative theorem:

- information-theoretic or rate-distortion views of compaction quality
- hot-spot preservation tiers based on access concentration
- causal-centrality-aware compaction vetoes
- entropy-driven tail selection instead of fixed turn-count rules
- explicit recovery-state machines triggered by retrieval failure (the vNext
  retrieval-failure signals S1/S2/S3 are defined separately in the vNext spec
  slice; they are not part of the current $C_{\mathrm{total}}$ theorem)

These are promising research directions for later versions. The current
document keeps the simpler invariant-first continuity model as the normative
contract until one of those stronger formulations is deliberately adopted.
