# Mathematical Reference

This document is the formal reference for the scoring and optimization math used
by the plugin. The gating scalar is documented separately in
[gating.md](./gating.md). The continuity model and recent-tail preservation
layer are documented in [continuity.md](./continuity.md). The authored
invariant/variant partitioning rules are documented in
[ast-v2.md](./ast-v2.md). The protected-shadow-rule Tier 1.5 model is
documented in [elevated-guidance.md](./elevated-guidance.md). Earlier
non-versioned math docs are preserved for
historical context, but the reviewed `*-v*` documents are authoritative when
both forms exist.

Every formula below points at the file that currently implements it. If the code
changes first, this document must change with it.

This revision (3.3) merges the complete section set from `mathematics.md` with
the formal corrections introduced in `mathematics-3-2.md`. All sections are now
present and carry the 3.2 corrections:

- explicit domain and startup invariants where later proofs depend on them
- removal of self-referential set definitions in the planned two-pass model
- disambiguation of decay symbols with different units and meanings
- explicit convex-combination proof obligations for bounded scores
- regularized Matryoshka normalization with $\varepsilon$-guarded denominators
  and explicit early-exit threshold values
- division-by-zero guards in compaction clustering ($n = 0$ and $k = 0$ cases)
- clamped confidence formula with per-backend range proofs
- cold-start smoothing in the authority-weight frequency term $f(d)$
- separated coarse-candidate raw set from filtered set in Pass 1
- $\eta_{\mathrm{hop}}$ symbol replacing bare $\lambda$ for hop attenuation
- startup invariant $\tau_{\mathcal{I}} \le \tau$ made explicit
- edge-case safety and quality-multiplier boundedness added as runtime invariants
- Unicode code-point correction in sidecar token estimator
- $\chi$ calibration notice tied to tokenizer validation

## 1. Hybrid Scoring

Each candidate returned by the vector store starts with a cosine similarity score
$\cos(q,d) \in [0,1]$ from embedding retrieval. The host then applies a hybrid
ranker:

$$
\mathrm{base}(d) =
\alpha \cdot \cos(q,d) +
\beta \cdot R(d) +
\gamma \cdot S(d)
$$

$$
\mathrm{score}(d) = \mathrm{base}(d) \cdot Q(d)
$$

where:

$$
R(d) = e^{-\lambda_s(d)\,\Delta t_d}
$$

$$
S(d)=
\begin{cases}
1.0 & \text{if } d \text{ is from the active session} \\
0.6 & \text{if } d \text{ is from durable namespace memory} \\
0.3 & \text{if } d \text{ is from global memory}
\end{cases}
$$

$$
Q(d)=
\begin{cases}
1 - \delta \cdot \mathrm{decay\_rate}(d) & \text{if } d \text{ is a summary} \\
1 & \text{otherwise}
\end{cases}
$$

Implemented in [`src/scoring.ts`](../src/scoring.ts).

The current implementation defaults are:

- $\alpha = 0.7$
- $\beta = 0.2$
- $\gamma = 0.1$
- $\delta = 0.5$

The runtime enforces this convex-mixture contract by clamping weights into
$[0,1]$ and re-normalizing them onto a unit sum before scoring. This keeps the
base score on a stable scale and makes tuning interpretable: increasing one
weight means explicitly decreasing another.

**Note on retrieval similarity.** The term $\cos(q,d) \in [0,1]$ represents the
similarity score as bounded at the host ranking boundary. If the retrieval layer
surfaces a negative cosine-style score, the host clamps it to $0$ before applying
the section-1 hybrid ranker. The planned two-pass system in Section 7 uses raw
cosine similarity spanning $[-1,1]$ with negatives clipped explicitly. These are
described separately to avoid conflating current implementation with planned
architecture.

### 1.1 Domain Constraints

The following parameter domains are required for all formulas in this section:

$$
\alpha, \beta, \gamma \in [0,1], \qquad \alpha + \beta + \gamma = 1
$$

$$
\delta \in [0,1]
$$

$$
\cos(q,d) \in [0,1], \qquad R(d) \in (0,1], \qquad S(d) \in \{0.3, 0.6, 1.0\}
$$

$$
\mathrm{decay\_rate}(d) \in [0,1]
$$

Under these assumptions, $\mathrm{base}(d)$ is a convex combination of
quantities in $[0,1]$, so:

$$
\mathrm{base}(d) \in [0,1]
$$

And since $\delta \in [0,1]$ and the decay rate is in $[0,1]$:

$$
Q(d) \in [1-\delta,\, 1] \subseteq [0,1]
$$

Therefore:

$$
\mathrm{score}(d) \in [0,1]
$$

### 1.2 Boundary Cases

- $\alpha = 1$ collapses to semantic retrieval only.
- $\beta = 1$ collapses to pure recency preference.
- $\gamma = 1$ collapses to scope-only ranking and is almost always wrong
  because it ignores content.
- $\delta = 0$ ignores summary quality completely.
- $\delta = 1$ applies the maximum configured penalty to low-confidence
  summaries while preserving nonnegativity, because
  the decay rate is in $[0,1]$, which guarantees $Q(d) \ge 0$.

### 1.3 Note on $S(d)$ Values

The scope weights $\{1.0, 0.6, 0.3\}$ are empirically tuned constants, not
values derived from a normalized probability model. They are intentionally
stable across query types. At the default $\gamma = 0.1$, the maximum
contribution of $S(d)$ to $\mathrm{base}(d)$ is $0.1$, so miscalibration of
these values has bounded impact on the final score. Future work may replace
this step function with access-frequency priors derived from retrieval
telemetry.

## 2. Recency Decay

Recency uses exponential decay:

$$
R(d) = e^{-\lambda_s \Delta t_d}
$$

where $\Delta t_d$ is the age of the record in seconds and $\lambda_s$ is the
scope-specific decay constant.

Implemented in [`src/scoring.ts`](../src/scoring.ts).

In the current implementation, $\Delta t_d$ is measured in **seconds**, not
milliseconds:

$$
\Delta t_d = \frac{\mathrm{Date.now()} - ts_d}{1000}
$$

and the $\lambda_s$ values are therefore **per-second** decay constants. The
product $\lambda_s \Delta t_d$ is dimensionless, as required by the exponential.

The current implementation uses different constants by scope:

- active session: $\lambda_s = 0.0001$
- durable namespace memory: $\lambda_s = 0.00001$
- global memory: $\lambda_s = 0.000002$

The implied half-lives make the decay constants auditable at a glance:

| Scope | $\lambda_s$ | Half-life |
|---|---|---|
| Session | $0.0001$ | $\approx 1.9\ \text{hours}$ |
| User | $0.00001$ | $\approx 19\ \text{hours}$ |
| Global | $0.000002$ | $\approx 4\ \text{days}$ |

$$
t_{1/2} = \frac{\ln 2}{\lambda_s}
$$

If those half-lives feel wrong for a given deployment, adjust $\lambda_s$ via
config — do not change the decay formula itself.

This makes session context fade fastest, durable namespace memory fade more slowly, and
global memory remain the most stable.

When the host supplies an explicit `userId`, the durable namespace matches that
`userId`. When the host does not provide a `userId`, the plugin derives a stable
durable namespace from the session key, or falls back to `session:${sessionId}`
when both `userId` and `sessionKey` are absent, so the retrieval math and scope
weighting stay unchanged even when the host does not expose a separate user principal.

**Note on symbol disambiguation.** The symbol $\lambda_s$ here denotes the
scope-specific recency decay constant with units $\mathrm{s}^{-1}$. Section 7.3
uses $\lambda_r$ for a separate recency constant in the planned authority weight.
Section 7.7 uses $\eta_{\mathrm{hop}}$ for a dimensionless hop attenuation
factor. These three parameters are distinct and must not be substituted for each
other.

Why exponential instead of linear:

- exponential decay preserves ordering smoothly across many time scales
- it never goes negative
- it gives a natural "fast drop then long tail" shape for conversational relevance

Linear decay has a hard cutoff or requires arbitrary clipping. Exponential decay
decays old memories continuously without inventing a discontinuity.

## 3. Token Budget Fitting

After ranking, the system performs greedy prompt packing.

Implemented in [`src/tokens.ts`](../src/tokens.ts).

Let candidates be sorted by final hybrid score:

$$
\mathrm{score}(d_1) \ge \mathrm{score}(d_2) \ge \dots \ge \mathrm{score}(d_n)
$$

and let $c_i$ be the estimated token cost of candidate $d_i$. The current host
token estimator is:

$$
\mathrm{estimateTokens}(t)=\left\lceil\frac{|t|}{\chi(t)}\right\rceil
$$

where:

$$
\chi(t)=
\begin{cases}
1.6 & \text{for CJK scripts} \\
2.5 & \text{for Cyrillic, Arabic, or Hebrew scripts} \\
4.0 & \text{otherwise}
\end{cases}
$$

Given prompt budget $B$, the system selects the longest ranked prefix whose
cumulative cost fits:

$$
S = [d_1, d_2, \dots, d_m]
$$

such that:

$$
\sum_{i=1}^{m} c_i \le B
$$

and either $m=n$ or $\sum_{i=1}^{m+1} c_i > B$.

Greedy is optimal for this implementation because the ranking is already fixed.
The problem is not "find the best weighted subset under a knapsack objective";
it is "preserve rank order while honoring a hard prompt cap." Once rank order
is fixed, prefix acceptance is the correct policy.

**Note on estimator divergence.** The host estimator
([`src/tokens.ts`](../src/tokens.ts)) is script-aware and is used for prompt
budget fitting. The sidecar estimator
([`sidecar/compact/tokens.go`](../sidecar/compact/tokens.go)) uses a fixed
normalization rule:

$$
\widehat{T}_{sidecar}(t)=\max\!\left(\left\lfloor\frac{C(t)}{4}\right\rfloor,\, 1\right)
$$

where $C(t)$ is the Unicode code-point count of the string. The sidecar uses
`utf8.RuneCountInString()` rather than `len()`, because Go's `len()` returns
the UTF-8 byte length, not the code-point count; a CJK character occupies 3
bytes, so `len()` would produce a systematic over-count relative to the host
estimator's character-based ratios. The remaining divergence is bounded in
impact because the sidecar value appears only as a normalization denominator
in $P(t)$, never in prompt-budget arithmetic.

The two estimators are intentionally different. The host estimator optimizes
prompt-budget accuracy. The sidecar estimator is used only as a stable
normalization denominator in the technical specificity signal $P(t)$ of the
gating scalar. They must not be substituted for each other.

**Note on $\chi$ calibration.** The ratios $\{1.6, 2.5, 4.0\}$ are validated
against GPT-4 family tokenizers. They should be re-validated against the
deployment tokenizer on a representative corpus sample whenever the tokenizer
changes; the validation script and its results should be committed alongside
this document.

## 4. Matryoshka Cascade

For Nomic embeddings, one full vector $\vec{v} \in \mathbb{R}^{768}$ produces
three tiers via regularized normalization:

$$
\vec{u}_{64} = \frac{\vec{v}_{1:64}}{\sqrt{\lVert \vec{v}_{1:64} \rVert_2^2 + \varepsilon^2}}, \quad
\vec{u}_{256} = \frac{\vec{v}_{1:256}}{\sqrt{\lVert \vec{v}_{1:256} \rVert_2^2 + \varepsilon^2}}, \quad
\vec{u}_{768} = \frac{\vec{v}_{1:768}}{\sqrt{\lVert \vec{v}_{1:768} \rVert_2^2 + \varepsilon^2}}
$$

where $\varepsilon = 10^{-8}$.

Re-normalization is required after truncation because a prefix of a unit vector
is not itself a unit vector in general. The regularized denominator
$\sqrt{\lVert \vec{v}_{1:k} \rVert_2^2 + \varepsilon^2}$ is numerically
identical to the plain $L_2$ norm when the norm is large, and smoothly forces
$\vec{u}_k \to \vec{0}$ when the norm approaches zero rather than producing NaN
or amplifying floating-point noise. A near-zero-norm tier vector yields a cosine
score near zero, which falls below both early-exit thresholds and produces
automatic fall-through to the next tier.

**Note on approximate unit normalization.** For any nonzero prefix with
$\varepsilon > 0$:

$$
\lVert \vec{u}_k \rVert_2
= \frac{\lVert \vec{v}_{1:k} \rVert_2}{\sqrt{\lVert \vec{v}_{1:k} \rVert_2^2 + \varepsilon^2}}
< 1
$$

So regularized prefix vectors are **approximately** unit-normalized. The
approximation becomes negligible when the prefix norm is large relative to
$\varepsilon$; with $\varepsilon = 10^{-8}$ and ordinary float32 prefix norms
this difference is not operationally significant, but the distinction matters
for formal correctness.

Implemented in [`sidecar/embed/matryoshka.go`](../sidecar/embed/matryoshka.go)
and [`sidecar/store/libravdb.go`](../sidecar/store/libravdb.go).

Cascade search uses:

- L1: `64d` with early-exit threshold $\theta_{L1} = 0.65$
- L2: `256d` with early-exit threshold $\theta_{L2} = 0.75$
- L3: `768d`

These thresholds are calibrated on held-out cosine rank correlation with the
768d ground truth for the chosen embedding model. They control the
precision/recall tradeoff of the cascade and are not required to preserve exact
ranking — rank preservation at reduced dimension is approximate by design of
Matryoshka prefix embeddings, not a mathematical guarantee. The L1 and L2 tiers
function as recall-oriented coarse filters; the false-positive rate at each tier
is an explicit design parameter controlled by $\theta_{L1}$ and $\theta_{L2}$.
If the embedding model changes, both thresholds must be re-derived from the new
model's ROC curve against 768d ground truth.

The search exits early when a tier's best score exceeds the configured threshold;
otherwise it falls through to the next tier. Empty lower-tier collections
degrade gracefully because:

$$
\max(\emptyset) = 0
$$

and $0$ is below both early-exit thresholds by design.

Backfill condition:

- L3 is the source of truth
- L1 and L2 are derived caches
- if an L1 or L2 insert fails, a dirty-tier marker is recorded
- startup backfill reconstructs the missing tier vector from L3

**Note on $\varepsilon$ calibration.** The value $\varepsilon = 10^{-8}$ is
appropriate for float32 embeddings where pathological near-zero norms are
numerical artifacts. If the embedding model changes, verify that near-zero norms
in the new model are indeed artifacts and not meaningful signal before retaining
this value.

## 5. Compaction Clustering

Compaction groups raw session turns into deterministic chronological clusters
and replaces each cluster with one summary record. The intent is to turn many
highly local turns into fewer retrieval-worthy summaries.

Implemented in [`sidecar/compact/summarize.go`](../sidecar/compact/summarize.go).

The current algorithm is not semantic k-means. It is deterministic chronological
partitioning:

1. collect eligible non-summary turns
2. sort them by `(ts, id)`
3. choose target cluster size $k$
4. normalize the requested target cluster size:

Non-positive runtime inputs are normalized to the shipped default
$k = 20$ before clustering. After normalization, the effective target size must
satisfy $k \ge 1$.

5. derive cluster count:

Let $n$ be the number of eligible turns. The cluster count is:

$$
c = \left\lceil \frac{\max(n,\,1)}{k} \right\rceil
$$

6. assign turn $i$ to cluster:

$$
\mathrm{clusterIndex}(i) = \left\lfloor \frac{i \cdot c}{\max(n,\,1)} \right\rfloor
$$

The $\max(n, 1)$ guards prevent division by zero when $n = 0$. When $n \ge 1$,
these are identical to the unguarded forms $\lceil n/k \rceil$ and
$\lfloor (i \cdot c)/n \rfloor$.

When $n < k$, the formula produces $c = 1$ and all turns map to cluster 0: a
single cluster containing fewer turns than the target size. Single-member
clusters should be tagged with method `trivial` so that downstream consumers can
apply a different quality interpretation if needed.

This yields contiguous chronological buckets of roughly equal size while
avoiding nondeterministic clustering behavior.

The summarizer input for cluster $C_j$ is the ordered turn sequence:

$$
C_j = [t_1, t_2, \dots, t_m]
$$

with each element carrying turn id and text.

The output is a summary record $s(C_j)$ with:

- summary text
- source ids
- confidence
- method
- `decay_rate = 1 - confidence`

Implemented across [`sidecar/compact/summarize.go`](../sidecar/compact/summarize.go),
[`sidecar/summarize/engine.go`](../sidecar/summarize/engine.go), and
[`sidecar/summarize/onnx_local.go`](../sidecar/summarize/onnx_local.go).

For the first real-model benchmark pass comparing raw T5 confidence against
Nomic-space preservation metrics and the hard preservation gate, see
[`compaction-evaluation.md`](./compaction-evaluation.md).

### 5.1 Semiotic Mismatch

The system uses:

- T5-small as an optional local abstractive decoder
- Nomic `nomic-embed-text-v1.5` as the canonical retrieval embedding space

Those models do not measure the same thing.

The raw T5 confidence term is:

$$
\mathrm{conf}_{\mathrm{t5}}(s, C_j) =
\exp\!\left(\frac{1}{m}\sum_{i=1}^{m}\log p(x_i \mid x_{<i}, C_j)\right)
$$

where $x_i$ are generated summary tokens. This measures decoder
self-consistency, not geometric preservation in the vector space used later for
retrieval.

So a T5 summary can be locally confident while still drifting away from the
source cluster in Nomic space.

### 5.2 Nomic-Space Preservation

Let the embedding function be:

$$
E : \text{text} \to \mathbb{R}^d
$$

For a source cluster $C_j = \langle t_1, \dots, t_n \rangle$, define:

$$
v_i = E(t_i)
$$

$$
\mu_C = \frac{1}{n}\sum_{i=1}^{n} v_i
$$

$$
v_s = E(s)
$$

where cosine similarity renormalizes vectors at comparison time, so $\mu_C$
does not need separate unit normalization in the definition below.

The primary preservation term is centroid alignment:

$$
Q_{\mathrm{align}}(s, C_j) = \cos(v_s, \mu_C)
$$

The secondary preservation term is average positive source coverage:

$$
Q_{\mathrm{cover}}(s, C_j) =
\frac{1}{n}\sum_{i=1}^{n}\max(0, \cos(v_s, v_i))
$$

The Nomic-space confidence term is then:

$$
\mathrm{conf}_{\mathrm{nomic}}(s, C_j) =
\max\!\left(0,\;\min\!\left(1,\;\frac{Q_{\mathrm{align}} + Q_{\mathrm{cover}}}{2}\right)\right)
$$

This is the canonical compaction quality signal because it is defined in the
same geometric space the vector store uses at retrieval time.

### 5.3 Preservation Gate

Before an abstractive T5 summary is accepted, it must pass a hard preservation
gate:

$$
Q_{\mathrm{align}}(s, C_j) \ge \tau_{\mathrm{preserve}}
$$

with the shipped default:

$$
\tau_{\mathrm{preserve}} = 0.65
$$

If the abstractive summary fails this test, the system rejects it and falls back
to deterministic extractive compaction.

This means the decoder may propose a summary, but Nomic-space preservation
decides whether it is faithful enough to become memory.

### 5.4 Final Confidence

For extractive summaries, the final stored confidence is:

$$
\mathrm{confidence}(s) = \mathrm{conf}_{\mathrm{nomic}}(s, C_j)
$$

For accepted abstractive T5 summaries, the final stored confidence is a
Nomic-heavy hybrid:

$$
\mathrm{confidence}(s) =
\lambda \cdot \mathrm{conf}_{\mathrm{nomic}}(s, C_j)
+ (1-\lambda)\cdot \mathrm{conf}_{\mathrm{t5}}(s, C_j)
$$

with the shipped default:

$$
\lambda = 0.8
$$

So Nomic-space preservation remains the dominant term, while T5 decoder
confidence contributes only auxiliary stability information.

Therefore:

$$
\mathrm{confidence}(s) \in [0,1]
$$

for all valid inputs, because both $\mathrm{conf}_{\mathrm{nomic}}$ and
$\mathrm{conf}_{\mathrm{t5}}$ are bounded in $[0,1]$ and the hybrid is a convex
combination.

### 5.5 Retrieval Decay Multiplier

The retrieval decay metadata is then:

$$
\mathrm{decay\_rate}(s) = 1 - \mathrm{confidence}(s)
$$

and the retrieval quality multiplier from Section 1 becomes:

$$
Q(s) = 1 - \delta \cdot \mathrm{decay\_rate}(s)
$$

Given $\delta \in [0,1]$ and $\mathrm{confidence}(s) \in [0,1]$, the decay rate
is in $[0,1]$ and therefore:

$$
Q(s) \in [1-\delta,\, 1] \subseteq [0,1]
$$

At the shipped default $\delta = 0.5$, this constrains summary quality weights
to:

$$
Q(s) \in [0.5,\, 1.0]
$$

This makes compaction load-bearing in retrieval rather than archival only.

### 5.6 Optional Lossless Compaction Extension

The current implementation replaces compacted session turns in the searchable
session collection after summary insertion succeeds. A stronger future variant
is to preserve compacted raw turns in an immutable session-history layer and
treat summary records as derived view nodes over that history. This extension is
inspired by the immutable-store and expandable-summary architecture in the LCM
paper ([Ehrlich and Blackman, 2026](https://papers.voltropy.com/LCM)), but the
formalization here is adapted to this repository's existing compaction and
continuity math.

Let:

$$
\mathcal{R}_{\mathrm{session}}=\langle r_1,\dots,r_n\rangle
$$

be the immutable raw session history, and let:

$$
\mathbf{S}=\{s_1,s_2,\dots\}
$$

be the set of compacted summary nodes. Define the summary-coverage DAG:

$$
\mathcal{G}_{\mathrm{cont}}=(\mathbf{S}\cup\mathcal{R}_{\mathrm{session}}, E_{\triangleleft})
$$

with:

$$
E_{\triangleleft}\subseteq (\mathbf{S}\times\mathbf{S})\cup(\mathbf{S}\times\mathcal{R}_{\mathrm{session}})
$$

Recursive raw expansion is:

$$
\mathrm{Expand}^{*}(x)=
\begin{cases}
\{x\} & \text{if } x\in\mathcal{R}_{\mathrm{session}} \\
\bigcup_{y:(x,y)\in E_{\triangleleft}} \mathrm{Expand}^{*}(y) & \text{if } x\in\mathbf{S}
\end{cases}
$$

The continuity contract for this extension is:

$$
\forall s\in\mathbf{S},\ \mathrm{Expand}^{*}(s)\neq\emptyset
$$

and:

$$
\forall r\in\mathcal{R}_{\mathrm{session}},\ \exists x\in \mathbf{S}\cup T_{\mathrm{recent}} \text{ such that } r\in\mathrm{Expand}^{*}(x)
$$

Under this extension, compaction changes the active retrievable view and the
assembly surface, but not the existence of raw historical evidence. This is
compatible with the section-1 through section-5 retrieval math because the
hybrid score still applies to the injected/searchable nodes; the extension only
strengthens the recoverability contract beneath those nodes.

## 6. Why These Pieces Compose

The full quality loop is:

$$
\text{high-value turns}
\rightarrow \text{better clusters}
\rightarrow \text{higher summary confidence}
\rightarrow \text{lower decay rate}
\rightarrow \text{higher retrieval score}
$$

That is the system-level reason the math is distributed across ingestion,
compaction, and retrieval instead of existing only in one scoring function.

For rigor, this section should be read in two parts:

- The upstream step
  `high-value turns -> better clusters -> higher summary confidence`
  is an engineering hypothesis supported by preservation metrics and empirical
  calibration evidence. It is not a pure algebraic proof obligation because it
  depends on learned-model behavior.
- The downstream step
  `higher summary confidence -> lower decay rate -> higher retrieval score`
  is a formal and implementation-correspondence obligation. It follows from:

$$
\mathrm{decay\_rate}(s) = 1 - \mathrm{confidence}(s)
$$

and

$$
Q(s) = 1 - \delta \cdot \mathrm{decay\_rate}(s),
\qquad
S_{\mathrm{final}}(s) = S_{\mathrm{base}}(s) \cdot Q(s)
$$

Under equal base score $S_{\mathrm{base}}$ and fixed $\delta \in [0,1]$,
higher confidence implies lower decay, larger $Q(s)$, and therefore a larger
final retrieval score. This downstream monotonic composition is the part that
must be locked by exact code-level tests before later retrieval architecture
work proceeds.

## 7. Two-Pass Discovery Scoring

This section documents the reviewed scoring and assembly model for the
two-pass retrieval system. Parts of this section are now implemented in
[`src/scoring.ts`](../src/scoring.ts),
[`src/context-engine.ts`](../src/context-engine.ts),
[`src/continuity.ts`](../src/continuity.ts), and the sidecar store/RPC
adapter. Remaining unimplemented or approximate pieces should be treated as
explicit follow-on work, not as permission to relax the mathematical contract.

The design goal is to separate:

1. invariant documents that must always be present
2. cheap discovery over variant documents
3. selective second-pass expansion under a hard prompt budget

### 7.1 Foundational Definitions

Let the retrievable document corpus be:

$$
\mathbf{D}=\{d_1, d_2, \ldots, d_n\}
$$

and let the query space be $\mathbf{Q}$.

Let the embedding function:

$$
\varphi : \mathbf{D}\cup\mathbf{Q}\rightarrow \mathbb{R}^m
$$

map documents and queries to unit vectors:

$$
\lVert \varphi(x) \rVert_2 = 1 \qquad \forall x \in \mathbf{D}\cup\mathbf{Q}
$$

The gating function is:

$$
G : \mathbf{Q}\times\mathbf{D}\rightarrow \{0,1\}
$$

and determines whether a document is injected for a query.

### 7.2 Corpus Decomposition

The reviewed AST partitioning model in [`ast-v2.md`](./ast-v2.md) refines the
older binary invariant-or-variant split into three authored tiers plus a
continuity carve-out inside the retrievable variant corpus.

The authored corpus is partitioned into hard invariants, soft invariants, and
variant memory:

$$
\mathbf{D} = \mathcal{I}_1\cup\mathcal{I}_2\cup\mathcal{V},
\qquad
\mathcal{I}_1\cap\mathcal{I}_2=\mathcal{I}_1\cap\mathcal{V}=\mathcal{I}_2\cap\mathcal{V}=\emptyset
$$

The tier membership predicate is:

$$
\iota : \mathbf{D}\rightarrow \{0,1,2\}
$$

with:

$$
\mathcal{I}_1 = \{d\in\mathbf{D}\mid \iota(d)=1\}
$$

and:

$$
\mathcal{I}_2 = \{d\in\mathbf{D}\mid \iota(d)=2\}
\qquad
\mathcal{V} = \{d\in\mathbf{D}\mid \iota(d)=0\}
$$

Here:

- $\mathcal{I}_1$ is the hard invariant set, injected exactly and never
  truncated
- $\mathcal{I}_2$ is the soft invariant sequence, injected by longest-prefix
  truncation in authored order
- $\mathcal{V}$ is the retrievable variant corpus

For OpenClaw, the intended implementation is that authored documents such as
`AGENTS.md` and `souls.md` are compiled into $\mathcal{I}_1$, $\mathcal{I}_2$,
and $\mathcal{V}$ at load time rather than discovered monolithically at query
time.

The hard authored guarantee is:

$$
\iota(d)=1 \Rightarrow G(q,d)=1 \qquad \forall q\in\mathbf{Q}
$$

Soft invariants are also authored constants, but unlike $\mathcal{I}_1$ they
are budget-elastic. Let the authored order on $\mathcal{I}_2$ be:

$$
\mathcal{I}_2=\langle d^{(2)}_1,d^{(2)}_2,\dots,d^{(2)}_m\rangle
$$

and define the longest-prefix operator:

$$
\mathrm{Pref}(\mathcal{I}_2;\,b)=\langle d^{(2)}_1,\dots,d^{(2)}_j\rangle
$$

where:

$$
j=\max\left\{r\in\{0,\dots,m\}\ \middle|\ \sum_{i=1}^{r}\mathrm{toks}(d^{(2)}_i)\le b\right\}
$$

When continuity is enabled, the runtime further refines the variant corpus into
an exact recent raw suffix and the remaining retrievable variant set:

$$
\mathcal{V}=T_{\mathrm{recent}}\cup\mathcal{V}_{\mathrm{rest}},
\qquad
T_{\mathrm{recent}}\cap\mathcal{V}_{\mathrm{rest}}=\emptyset
$$

Only $\mathcal{V}_{\mathrm{rest}}$ participates in semantic retrieval. The
recent tail is preserved exactly and budgeted separately.

### 7.3 Document Authority Weight

Each retrievable variant document carries a precomputed authority weight:

$$
\omega(d)=\alpha_r\cdot r(d)+\alpha_f\cdot f(d)+\alpha_a\cdot a(d)
$$

with:

$$
\alpha_r+\alpha_f+\alpha_a=1, \qquad \alpha_r,\alpha_f,\alpha_a \in [0,1]
$$

where:

$$
r(d)=\exp\!\left(-\lambda_r\cdot \Delta t(d)\right)
$$

$$
f(d)=\frac{\log(1+\mathrm{acc}(d))}{\log\!\left(1+\max_{d'\in\mathcal{V}_{\mathrm{rest}}}\mathrm{acc}(d')+1\right)}
$$

$$
a(d)\in[0,1]
$$

Here $\lambda_r > 0$ is the recency decay constant with units $\mathrm{s}^{-1}$,
and $\Delta t(d) \ge 0$ is document age in seconds.

The $+1$ in the denominator of $f(d)$, but not the numerator, implements minimal
additive smoothing that guarantees a defined value at cold start. The asymmetry
is deliberate: a document with zero accesses should score $f(d) = 0$ exactly,
which the unsmoothed numerator preserves. When
$\max_{d'\in\mathcal{V}_{\mathrm{rest}}}\mathrm{acc}(d') = 0$, the denominator equals $\log 2$
and:

$$
f(d) = 0 \qquad \forall d\in\mathcal{V}_{\mathrm{rest}}
$$

cleanly deferring frequency weight to $r(d)$ and $a(d)$ until access history
accumulates.

Because $r(d)\in(0,1]$, $f(d)\in[0,1]$, and $a(d)\in[0,1]$, and $\omega(d)$
is a convex combination of these terms:

$$
\omega(d)\in[0,1]
$$

For variant nodes extracted from core authored identity documents,
[`ast-v2.md`](./ast-v2.md) sets $a(d)=1.0$. This lets the planned discovery
score incorporate recency, access frequency, and authored authority without
baking those concerns into the raw cosine term.

### 7.4 Pass 1: Coarse Semantic Filtering

Pass 1 computes cosine similarity:

$$
\mathrm{sim}(q,d)=\varphi(q)^\top \varphi(d) \in [-1,1]
$$

The raw top-$k_1$ candidate set is:

$$
\mathcal{C}_1^{\mathrm{raw}}(q)=\mathrm{TopK}_{d\in\mathcal{V}_{\mathrm{rest}}}\!\left(k_1,\,\mathrm{sim}(q,d)\right)
$$

with filtered coarse set:

$$
\mathcal{C}_1(q)=\left\{d\in\mathcal{C}_1^{\mathrm{raw}}(q)\mid \mathrm{sim}(q,d)\ge \theta_1\right\}
$$

where $\theta_1\in[-1,1]$.

The purpose of this pass is breadth with cheap semantic recall. Documents below
$\theta_1$ are rejected even if they land in the top-$k_1$ set, because the
first pass must not admit semantically orthogonal noise into second-pass work.

### 7.5 Pass 2: Normalized Hybrid Scoring

Let the query keyword extractor return:

$$
K = \mathrm{KeyExt}(q)
$$

and define normalized keyword coverage:

$$
M_{norm}(K,d)=\frac{|K\cap \mathrm{terms}(d)|}{\max(|K|,\,1)}\in[0,1]
$$

When $|K| > 0$ this is identical to $|K\cap \mathrm{terms}(d)| / |K|$. When
$|K| = 0$ (the query yields no extractable keywords), the numerator is zero and
$M_{norm} = 0$ exactly, collapsing the second-pass score to pure semantic
retrieval — the correct degenerate behavior.

The proposed normalized second-pass score is:

$$
S_{final}(d)=
\frac{
\omega(d)\cdot\max(\mathrm{sim}(q,d),\,0)\cdot\left(1+\kappa\cdot M_{norm}(K,d)\right)
}{
1+\kappa
}
$$

where $\kappa\in[0,\infty)$.

The normalized second-pass score form above was suggested during design review
by GitHub contributor [@JuanHuaXu](https://github.com/JuanHuaXu). The broader
two-pass architecture in this section remains project-authored.

This form is preferred over a hard clamp such as $\min(\mathrm{term},1)$
because clamping discards ranking information at the high end of the score
distribution. The denominator $(1+\kappa)$ gives an analytic bound instead of
truncating the result.

The second-pass candidate set is:

$$
\mathcal{C}_2(q)=\mathrm{TopK}_{d\in\mathcal{C}_1(q)}\!\left(k_2,\,S_{final}(d)\right)
$$

with $k_2 \le k_1$ and $k_1, k_2 \in \mathbb{Z}_{>0}$.

### 7.6 Bounded Range and Interpretation of $\kappa$

Let:

$$
s=\max(\mathrm{sim}(q,d),\,0)\in[0,1]
$$

Then:

$$
S_{final}(d)=\frac{\omega(d)\cdot s\cdot(1+\kappa M_{norm}(K,d))}{1+\kappa}
$$

Because $M_{norm}(K,d)\in[0,1]$ and $\kappa\ge 0$:

$$
1 \le 1+\kappa M_{norm}(K,d) \le 1+\kappa
$$

so:

$$
0 \le \frac{1+\kappa M_{norm}(K,d)}{1+\kappa} \le 1
$$

Combining with $s\in[0,1]$ and $\omega(d)\in[0,1]$:

$$
0 \le S_{final}(d)\le \omega(d)\le 1
$$

This yields a clean interpretation of $\kappa$:

- $\kappa = 0$ gives pure semantic retrieval
- $\kappa = 0.5$ allows keyword coverage to provide up to a one-third relative
  boost before normalization
- $\kappa = 1.0$ makes full lexical support restore the pure semantic ceiling
  while penalizing semantic-only matches with no keyword support

A reasonable initial experiment value is:

$$
\kappa = 0.3
$$

### 7.7 Multi-Hop Expansion

Let the authored hop graph be:

$$
\mathcal{G}=(\mathbf{D},\, E)
$$

where edges are registered in document metadata at authorship time.

For a document $d$, define its hop neighborhood:

$$
H(d)=\{d'\in\mathbf{D}\mid (d,d')\in E\}
$$

The hop expansion set is:

$$
\mathcal{C}_{hop}(q)=\bigcup_{d\in\mathcal{C}_2(q)} H(d)\setminus\mathcal{C}_2(q)
$$

Each hop candidate inherits a decayed score from its best parent:

$$
S_{hop}(d')=
\eta_{\mathrm{hop}}\cdot
\max_{d\in\mathcal{C}_2(q),\; d'\in H(d)} S_{final}(d)
$$

with hop decay factor $\eta_{\mathrm{hop}}\in(0,1)$.

**Note on symbol disambiguation.** The symbol $\eta_{\mathrm{hop}}$ is used
here deliberately to avoid collision with $\lambda_s$ (scope recency, Section 2)
and $\lambda_r$ (authority-weight recency, Section 7.3). The parameters have
different semantics and units: $\lambda_r$ has units $\mathrm{s}^{-1}$, while
$\eta_{\mathrm{hop}}$ is a dimensionless attenuation factor in $(0,1)$.

The filtered hop set is:

$$
\mathcal{C}_{hop}^{*}(q)=\{d'\in\mathcal{C}_{hop}(q)\mid S_{hop}(d')\ge\theta_{hop}\}
$$

with $\theta_{hop}\in[0,1]$.

Since $S_{final}(d)\in[0,1]$ and $\eta_{\mathrm{hop}}\in(0,1)$:

$$
S_{hop}(d')\in[0,\,1)
$$

### 7.8 Final Assembly Under a Token Budget

Variant projection is:

$$
\mathrm{Proj}(\mathcal{V}_{\mathrm{rest}},\, q)=\mathcal{C}_2(q)\cup\mathcal{C}_{hop}^{*}(q)
$$

The final injected context is:

$$
C_{\mathrm{total}}(q)=\mathcal{I}_1\cup \mathcal{I}_2^{*}\cup T_{\mathrm{recent}}\cup \mathrm{Proj}(\mathcal{V}_{\mathrm{rest}},\, q)
$$

Let the total prompt budget be $\tau$, and let the reserve fractions satisfy:

$$
\alpha_1,\alpha_2,\beta\in[0,1],
\qquad
\alpha_1+\alpha_2+\beta\le 1
$$

where:

- $\alpha_1$ reserves hard authored budget
- $\alpha_2$ reserves soft authored budget
- $\beta$ is the target recent-tail budget fraction

Define the hard authored token mass:

$$
\tau_{\mathcal{I}_1}=\sum_{d\in\mathcal{I}_1}\mathrm{toks}(d)
$$

**Required startup hard authored invariant:**

$$
\tau_{\mathcal{I}_1}\le \alpha_1\tau
$$

This must be enforced at startup or configuration validation time. If violated,
the system cannot simultaneously satisfy "the hard invariant set is never
truncated" and "total injected tokens do not exceed the total budget."
Initialization must fail or the deployment must be reconfigured.

Let $T_{\mathrm{base}}$ be the mandatory recent-tail base suffix defined in
[`continuity.md`](./continuity.md): the shortest raw suffix of the active
session containing at least the most recent $m$ turns. The mandatory continuity
fit requirement is:

$$
\tau_{\mathcal{I}_1} + \sum_{d\in T_{\mathrm{base}}}\mathrm{toks}(d)\le \tau
$$

Otherwise no legal assembly exists that preserves both hard invariants and the
minimum continuity tail. The runtime must surface degraded mode explicitly; it
must not silently truncate $\mathcal{I}_1$ or split the mandatory recent tail.

The effective soft authored budget is:

$$
\tau_{\mathcal{I}_2}^{\mathrm{eff}}
=
\min\!\left(
\alpha_2\tau,\,
\tau-\tau_{\mathcal{I}_1}-\sum_{d\in T_{\mathrm{base}}}\mathrm{toks}(d)
\right)
$$

and the injected soft invariant prefix is:

$$
\mathcal{I}_2^{*}=\mathrm{Pref}(\mathcal{I}_2;\,\tau_{\mathcal{I}_2}^{\mathrm{eff}})
$$

Define the recent-tail target:

$$
\tau_{\mathrm{tail}}^{\mathrm{target}}=\beta\tau
$$

The exact recent-tail selector is the longest bundle-safe raw suffix containing
$T_{\mathrm{base}}$ and satisfying:

$$
\sum_{d\in T_{\mathrm{recent}}}\mathrm{toks}(d)
\le
\min\!\left(
\max\!\left(\tau_{\mathrm{tail}}^{\mathrm{target}},\,
\sum_{d\in T_{\mathrm{base}}}\mathrm{toks}(d)\right),\,
\tau-\tau_{\mathcal{I}_1}-\sum_{d\in\mathcal{I}_2^{*}}\mathrm{toks}(d)
\right)
$$

This preserves the continuity rule that the mandatory recent suffix wins over
the nominal tail target when they conflict, while still respecting the total
prompt budget.

The residual retrievable variant budget is:

$$
\tau_{\mathcal{V}}(q)
=
\tau-\tau_{\mathcal{I}_1}
-\sum_{d\in\mathcal{I}_2^{*}}\mathrm{toks}(d)
-\sum_{d\in T_{\mathrm{recent}}}\mathrm{toks}(d)
$$

which must satisfy:

$$
\tau_{\mathcal{V}}(q)\ge 0
$$

Documents in $\mathrm{Proj}(\mathcal{V}_{\mathrm{rest}}, q)$ are injected in descending
score order until:

$$
\sum_{d\in \text{injected}} \mathrm{toks}(d)\le\tau_{\mathcal{V}}
$$

The merged score sequence is:

$$
\sigma(d)=
\begin{cases}
S_{final}(d) & d\in\mathcal{C}_2(q) \\
S_{hop}(d) & d\in\mathcal{C}_{hop}^{*}(q)
\end{cases}
$$

### 7.9 Complete Gating Definition

$$
G(q,d)=
\begin{cases}
1 & \text{if } d\in\mathcal{I}_1\cup\mathcal{I}_2^{*}\cup T_{\mathrm{recent}} \\
\mathbf{1}[d\in\mathcal{C}_2(q)\cup\mathcal{C}_{hop}^{*}(q)] & \text{if } d\in\mathcal{V}_{\mathrm{rest}}
\end{cases}
$$

### 7.10 Required Runtime Invariants

The implementation must preserve these properties:

1. Invariant completeness:

$$
\forall d\in\mathcal{I}_1,\; \forall q\in\mathbf{Q}: d\in C_{\mathrm{total}}(q)
$$

2. Soft invariant order preservation:

$$
\mathcal{I}_2^{*}\text{ is a prefix of }\mathcal{I}_2
$$

3. Partition integrity:

$$
\mathcal{I}_1\cap\mathcal{I}_2=\mathcal{I}_1\cap\mathcal{V}=\mathcal{I}_2\cap\mathcal{V}=\emptyset,
\qquad
T_{\mathrm{recent}}\cap\mathcal{V}_{\mathrm{rest}}=\emptyset
$$

4. Mandatory recent-tail completeness:

$$
T_{\mathrm{base}}\subseteq T_{\mathrm{recent}}
$$

5. Score boundedness:

$$
S_{final}(d)\in[0,1]
$$

6. Token budget respect:

$$
\sum_{d\in C_{\mathrm{total}}(q)} \mathrm{toks}(d)\le\tau
$$

with $\mathcal{I}_1$ never truncated, $\mathcal{I}_2$ truncated only by
longest-prefix selection, and the recent-tail base never silently dropped.

7. Compaction boundary safety:

Compaction may operate only on $\mathcal{V}_{\mathrm{rest}}$, never on
$T_{\mathrm{recent}}$.

8. Hop termination:

The authored hop graph should be acyclic, or the runtime must cap hop depth at
one to guarantee termination.

9. Edge-case safety:

No valid input in the declared domain may produce a NaN, a negative score, or a
division-by-zero. This includes at minimum:

- cold-start corpus with $\max \mathrm{acc}=0$
- empty extracted keyword set with $|K|=0$
- zero eligible clustering turns with $n=0$
- near-zero-norm Matryoshka prefix vectors
- empty hop neighborhoods
- empty or zero-residual $\tau_{\mathcal{V}}(q)$ after invariant and
  continuity reservation

7. Quality multiplier boundedness:

$$
\mathrm{confidence}(s)\in[0,1],
\qquad
Q(d)\in[1-\delta,\,1]\subseteq[0,1]
$$

for all valid inputs with $\delta\in[0,1]$.

## 8. Theory Boundary And Future Refinement

Cross-review of this document and [`continuity.md`](./continuity.md) surfaced a
useful mathematical boundary that this reference should keep explicit:

1. storage and continuity axioms
2. primary retrieval and assembly math
3. optional recoverability policy

### 8.1 What Is Core Math

The core retrieval theorem in this document is the scored, budgeted selection
of retrievable nodes from $\mathcal{V}_{\mathrm{rest}}$ together with authored
invariants and the exact recent tail. In other words, the primary law remains:

$$
C_{\mathrm{total}}(q)=\mathcal{I}_1\cup \mathcal{I}_2^{*}\cup T_{\mathrm{recent}}\cup \mathrm{Proj}(\mathcal{V}_{\mathrm{rest}}, q)
$$

with the retrieval side governed by:

$$
S_{\mathrm{final}}(d)=S_{\mathrm{base}}(d)\cdot Q(d)
$$

and the budget side governed by the residual variant budget
$\tau_{\mathcal{V}}(q)$ defined in Section 7.8.

### 8.2 What Is Not Core Math

The following should be treated as policy or heuristic unless they are derived
from the governing score equations and budget laws:

- automatic query-time summary expansion
- fixed expansion penalties
- fixed expansion token sub-budgets
- confidence thresholds for expansion eligibility
- recursion-depth limits for summary expansion

These controls may be useful in runtime experiments, but they are not theorem
terms by default. They should not be mistaken for new axioms of the scoring
model.

### 8.3 Lossless Does Not Mean Always Expand

The lossless extension in Section 5.6 strengthens the storage and
recoverability contract. It does not imply that every relevant summary should be
expanded into raw turns during ordinary retrieval.

The mathematically safe reading is:

- raw immutability is an axiom
- $\mathrm{Expand}^{*}$ is a recoverability theorem over the summary DAG
- query-time expansion is **explicit recovery/audit only** — it was removed from
  the hot retrieval path and is not the default behavior; any expansion beyond
  the core $C_{\mathrm{total}}(q)$ assembly must be triggered deliberately, not
  applied silently to ranked candidates

This distinction preserves the design goal that continuity and recoverability
support retrieval without silently replacing it.

### 8.4 Preferred Direction For Future Refinement

If a future version wants query-time expansion inside the main retrieval path,
the preferred direction is to re-derive it from the existing two-pass and
multi-hop framework rather than introduce standalone penalties and thresholds
that float outside the score model.

In practical terms, future refinement should prefer one of two paths:

1. keep summary expansion as a separate recovery or audit layer
2. formally unify summary expansion with the existing hop-expansion math

What this document should avoid is an in-between state where recoverability
logic behaves like a second retrieval theorem without being derived as one.

### 8.5 Preserved Research Ideas

The review process also surfaced several strong theoretical ideas that are worth
retaining for future work:

- rate-distortion views of compaction quality
- information-adaptive clustering instead of equal-size chronological buckets
- hot-spot preservation tiers driven by access concentration
- causal-centrality-aware compaction penalties or vetoes
- entropy-based tail selection
- retrieval-failure-triggered raw-history recovery (the specific observable
  signals S1/S2/S3 are defined in the vNext spec slice; this entry refers to the
  general concept, not the current implementation)
- closed-loop compaction tuning driven by observed retrieval quality

These ideas are intentionally preserved as future mathematics rather than
current contract. The present document remains normative only for the formulas
and invariants already defined above.

## 9. Temporal-Compositional Retrieval Extension

This section defines a narrow, mathematically principled extension to the
$\mathrm{Proj}()$ operator that corrects the single-turn-centric failure mode on
temporal-compositional queries such as "how many days before $X$ did $Y$
happen."

The extension is self-contained. Every formula in this section is bounded and
correct under the existing parameter domains. The assembly law
$C_{\mathrm{total}}(q)$, the budget hierarchy, and the runtime invariants in
Section 7.10 and [`continuity.md`](./continuity.md) are unchanged. Only the
internal definition of $\mathrm{Proj}(\mathcal{V}_{\mathrm{rest}}, q)$ is
refined.

Implemented in: `src/temporal.ts` (planned).

### 9.1 Motivation: The Set-Scoring Gap

The standard Pass-2 score $S_{\mathrm{final}}(d)$ maximizes over individual
candidates:

$$
\mathcal{C}_2(q)
=
\mathrm{TopK}_{d \in \mathcal{C}_1(q)}
\left(k_2,\, S_{\mathrm{final}}(d)\right)
$$

This is optimal when the query is answerable from a single best document. It
fails when the query requires two complementary date-bearing turns to be
jointly present, neither of which is individually the best semantic match.

The failure pattern is:

- Turn $A$ covers the query topic broadly, so it earns a high
  $S_{\mathrm{final}}$ and wins alone.
- Turn $B$ contains the missing date anchor, but earns only a moderate
  $S_{\mathrm{final}}$ and is evicted.
- Neither $A$ alone nor $B$ alone answers the question.

The fix is to move from
$\underset{d}{\arg\max}\; S_{\mathrm{final}}(d)$ to a coverage-aware set
selector that rewards a set of candidates for jointly maximizing semantic
relevance, temporal anchor density, and event-slot coverage while penalizing
redundancy automatically via marginal scoring.

### 9.2 Temporal Query Indicator $\xi(q)\in[0,1]$

To avoid mutating the retrieval contract for normal queries, the extension
activates only when the query is detected to be temporal-compositional.
Define the temporal query indicator using the same saturating-sum pattern as
$T(t)$ in [`gating.md`](./gating.md):

$$
\xi(q)
=
\min\!\left(
  \frac{\displaystyle\sum_i s_i \cdot \mathbf{1}[\mathrm{tpat}_i(q)]}
       {\theta_{\xi}^{\mathrm{norm}}},
  1
\right)
$$

where the shipped temporal patterns $\mathrm{tpat}_i$ are zero-allocation
byte-lexer matches over the query text, including but not limited to
"how many days", "how long", "before", "after", "since", "first", "earlier",
"which came first", "when did", and "between".

Each pattern carries a weight $s_i > 0$. The default normalization constant is
$\theta_{\xi}^{\mathrm{norm}} = 1.5$, so two strong temporal signals saturate
$\xi(q)=1$.

By construction, the $\min(\cdot, 1)$ clamp and non-negative numerator
guarantee:

$$
\xi(q)\in[0,1]
$$

If no temporal patterns match, $\xi(q)=0$ and the extension contributes
nothing to the scoring formula.

The extension activates only when $\xi(q)\ge\theta_\xi$, with shipped default
$\theta_\xi = 0.3$. Below that threshold, the standard $\mathrm{Proj}$ path
executes without modification.

### 9.3 Temporal Anchor Density $A(d)\in[0,1]$

A document's temporal anchor density measures how many explicit date or time
expressions it contains, normalized by a bounded saturation constant.
Define the anchor count over a lightweight anchor pattern set $\mathcal{P}_A$
(ISO dates, relative day expressions, clock times, calendar words, Unix
timestamps):

$$
A(d)
=
\min\!\left(
  \frac{\displaystyle\sum_j \mathbf{1}[\mathrm{anch}_j(d)]}
       {\theta_A^{\mathrm{norm}}},
  1
\right)
$$

The default $\theta_A^{\mathrm{norm}} = 3$, so three or more distinct anchor
expressions saturate $A(d)=1$.

Again, the clamp guarantees:

$$
A(d)\in[0,1]
$$

$A(d)$ is a precomputed document-level scalar. It does not depend on the query
and should be cached in the same document-addressed cache $\Psi$ defined in
[`ast-v2.md`](./ast-v2.md) Section 7 alongside tier partition and budget
metadata. The value must be recomputed whenever a stored document is created,
updated, or regenerated by compaction.

### 9.4 Event-Slot Extraction and Marginal Coverage $\Delta\Phi$

#### 9.4.1 Event-Slot Extraction

For a temporal-compositional query $q$, define the event-slot set:

$$
E(q)=\langle e_1, e_2, \dots, e_m \rangle
$$

where each $e_j$ is a short noun-phrase span extracted from $q$ by a
lightweight span extractor: named entities plus the main noun phrase preceding
and following any detected temporal-pattern word. The extractor returns at
most $m_{\max}=4$ slots to bound cost.

When $|E(q)|=0$, all coverage terms evaluate to zero and the formula degrades
cleanly.

#### 9.4.2 Per-Slot Coverage Indicator

For each slot $e_j$ and candidate document $d$, define the binary slot-match
indicator:

$$
\phi_j(d)
=
\mathbf{1}\!\left[\varphi(e_j)^\top \varphi(d) \ge \theta_e\right]
\in \{0,1\}
$$

where $\varphi(\cdot)$ is the same unit-normalized embedding function defined
in Section 7.1, and $\theta_e \in [-1,1]$ is the slot-match similarity
threshold, default $\theta_e = 0.50$.

#### 9.4.3 Marginal Coverage

For a set $\mathcal{S}$ of already-selected documents, define the marginal
coverage of adding $d$:

$$
\Delta\Phi(d, \mathcal{S}, q)
=
\frac{1}{\max(|E(q)|, 1)}
\sum_{j=1}^{|E(q)|}
\phi_j(d)
\cdot
\mathbf{1}\!\left[\nexists d' \in \mathcal{S} : \phi_j(d') = 1\right]
$$

This is the fraction of uncovered event slots that $d$ newly covers.

The outer factor is in $(0,1]$, the sum counts at most $|E(q)|$ binary terms,
and therefore:

$$
\Delta\Phi(d, \mathcal{S}, q)\in[0,1]
$$

The indicator
$\mathbf{1}\!\left[\nexists d' \in \mathcal{S} : \phi_j(d') = 1\right]$
ensures that slots already covered by a previously selected document
contribute zero marginal gain, automatically penalizing redundant anchor turns
without a separate explicit penalty term.

As $|\mathcal{S}|$ grows, $\Delta\Phi(d,\mathcal{S},q)$ is monotone
non-increasing: new selections can only cover more slots, leaving fewer
uncovered slots for later candidates to gain credit for.

### 9.5 Coverage-Augmented Blended Score
$S_{\mathrm{proj}}(d,\mathcal{S},q)\in[0,1]$

Define the coverage-augmented score for candidate $d$ given already-selected
set $\mathcal{S}$ and query $q$:

$$
S_{\mathrm{cov}}(d, \mathcal{S}, q)
=
\mu \cdot S_{\mathrm{final}}(d)
+ \nu \cdot A(d)
+ \rho \cdot \Delta\Phi(d, \mathcal{S}, q)
$$

where:

$$
\mu,\nu,\rho\in[0,1],
\qquad
\mu+\nu+\rho=1
$$

The default shipped weights are $\mu=0.60$, $\nu=0.20$, and $\rho=0.20$.

Blend this with the standard score using $\xi(q)$ as an interpolation scalar:

$$
S_{\mathrm{proj}}(d, \mathcal{S}, q)
=
(1 - \xi(q)) \cdot S_{\mathrm{final}}(d)
+ \xi(q) \cdot S_{\mathrm{cov}}(d, \mathcal{S}, q)
$$

Substituting $S_{\mathrm{cov}}$ yields:

$$
S_{\mathrm{proj}}
=
\bigl(1 - \xi(1-\mu)\bigr)\cdot S_{\mathrm{final}}
+ \xi\nu \cdot A
+ \xi\rho \cdot \Delta\Phi
$$

All coefficients are non-negative, and they sum to one:

$$
\bigl(1 - \xi(1-\mu)\bigr) + \xi\nu + \xi\rho
=
1 - \xi + \xi\mu + \xi\nu + \xi\rho
=
1 - \xi + \xi(\mu+\nu+\rho)
=
1
$$

Because $S_{\mathrm{final}}(d)$, $A(d)$, and
$\Delta\Phi(d,\mathcal{S},q)$ all lie in $[0,1]$, this is a proper convex
combination, so:

$$
S_{\mathrm{proj}}(d,\mathcal{S},q)\in[0,1]
$$

Degeneracy cases:

| Condition | Behavior |
| --- | --- |
| $\xi(q)=0$ | $S_{\mathrm{proj}} = S_{\mathrm{final}}(d)$; standard retrieval unchanged |
| $\xi(q)=1$, $\nu=\rho=0$, $\mu=1$ | Explicit no-op configuration; still $S_{\mathrm{proj}} = S_{\mathrm{final}}(d)$ |
| $|E(q)|=0$ | $\Delta\Phi=0$ for all $d$; the $\rho$ term vanishes |
| $\mathcal{S}=\emptyset$ | $\Delta\Phi$ equals full slot-coverage fraction |
| all slots already covered by $\mathcal{S}$ | $\Delta\Phi=0$ for all remaining $d$ |

Note: the greedy selector below optimizes a submodular coverage term
$\Delta\Phi$ augmented with fixed document priors $S_{\mathrm{final}}(d)$ and
$A(d)$. The classic $(1-1/e)$ approximation guarantee applies strictly to the
coverage component; in practice the blended score preserves greedy usefulness
for temporal anchor selection.

### 9.6 Temporal Recovery Candidate Set
$\mathcal{C}_{\mathrm{rec}}(q)$

The root cause of the observed benchmark failure is not only that documents are
scored incorrectly; it is also that the necessary complementary anchor turn may
never enter $\mathcal{C}_2(q)$ because its semantic similarity to the
whole-query embedding is too low.

A bounded recovery pass admits anchor-rich documents below the normal Pass-1
threshold:

$$
\mathcal{C}_{\mathrm{rec}}(q)
=
\mathrm{TopK}_{d \in
\left\{d' \in \mathcal{V}_{\mathrm{rest}} :
\mathrm{sim}(q,d') \ge \theta_{\mathrm{rec}}\right\}}
\left(k_{\mathrm{rec}},\, A(d)\right)
\setminus \mathcal{C}_2(q)
$$

where:

- $\theta_{\mathrm{rec}} < \theta_1$ is a looser semantic floor, default
  $\theta_{\mathrm{rec}} = 0.15$, preventing pure noise while still admitting
  anchor-heavy but semantically distant turns.
- $k_{\mathrm{rec}}$ is a small cap, default $k_{\mathrm{rec}} = 10$, bounding
  recovery cost to $O(k_{\mathrm{rec}})$.

The combined candidate pool for the greedy selector is:

$$
\mathcal{C}_{\mathrm{pool}}(q)
=
\mathcal{C}_2(q)\cup\mathcal{C}_{\mathrm{rec}}(q)
$$

By construction,
$\mathcal{C}_{\mathrm{pool}}(q)\subseteq\mathcal{V}_{\mathrm{rest}}$, so
partition integrity is preserved.

### 9.7 Greedy Coverage-Aware Selector

Given $\mathcal{C}_{\mathrm{pool}}(q)$, the selector builds the final chosen
set greedily, using the same rank-then-prefix-accept spirit as the existing
token-budget packing in Section 7.8.

Let $k_{\mathrm{cov}}\le k_2$ be the maximum number of anchor turns to select,
default $k_{\mathrm{cov}}=3$.

Initialize:

$$
\mathcal{S}_0 = \emptyset
$$

For $i = 0, 1, \dots, k_{\mathrm{cov}}-1$:

$$
d_i^*
=
\underset{d \in \mathcal{C}_{\mathrm{pool}}(q)\setminus\mathcal{S}_i}{\arg\max}
\;
S_{\mathrm{proj}}(d, \mathcal{S}_i, q)
$$

Early stop if:

$$
S_{\mathrm{proj}}(d_i^*, \mathcal{S}_i, q) < \theta_{\mathrm{stop}}
$$

with default $\theta_{\mathrm{stop}}=0.10$. Otherwise:

$$
\mathcal{S}_{i+1} = \mathcal{S}_i \cup \{d_i^*\}
$$

The final selected set is $\mathcal{S}^*(q)$, or the earlier set at which
early stopping triggered.

Each greedy step scans at most
$|\mathcal{C}_{\mathrm{pool}}(q)| \le k_2 + k_{\mathrm{rec}}$ candidates.
Total complexity is therefore:

$$
O\!\left(k_{\mathrm{cov}} \cdot (k_2 + k_{\mathrm{rec}})\right)
$$

which is negligible relative to embedding and vector-search cost.

### 9.8 Modified Projection Operator

The temporal extension redefines $\mathrm{Proj}$ conditionally:

$$
\mathrm{Proj}(\mathcal{V}_{\mathrm{rest}}, q)
=
\begin{cases}
\mathcal{S}^*(q)\cup\mathcal{C}_{hop}^{*}(q)
& \text{if } \xi(q) \ge \theta_\xi \\[4pt]
\mathcal{C}_2(q)\cup\mathcal{C}_{hop}^{*}(q)
& \text{otherwise}
\end{cases}
$$

The assembly law and budget equations remain unchanged:

$$
C_{\mathrm{total}}(q)=\mathcal{I}_1\cup\mathcal{I}_2^{*}\cup T_{\mathrm{recent}}\cup \mathrm{Proj}(\mathcal{V}_{\mathrm{rest}}, q)
$$

$$
\tau_{\mathcal{V}}(q)
=
\tau-\tau_{\mathcal{I}_1}
-\sum_{d\in\mathcal{I}_2^{*}}\mathrm{toks}(d)
-\sum_{d\in T_{\mathrm{recent}}}\mathrm{toks}(d)
$$

Documents in $\mathrm{Proj}(\mathcal{V}_{\mathrm{rest}}, q)$ are injected in
descending $\sigma(d)$ order until $\tau_{\mathcal{V}}(q)$ is exhausted.

For documents entering through the temporal selector, the merged score sequence
is extended:

$$
\sigma(d)=
\begin{cases}
S_{\mathrm{proj}}(d, \mathcal{S}^*\setminus\{d\}, q)
& d\in\mathcal{S}^*(q) \\
S_{hop}(d)
& d\in\mathcal{C}_{hop}^{*}(q)
\end{cases}
$$

For documents that were already present in $\mathcal{C}_2(q)$, the standard
$S_{\mathrm{final}}(d)$ path remains authoritative and duplicates are excluded
by construction.

### 9.9 Preservation of Section 7.10 Runtime Invariants

All runtime invariants from Section 7.10 remain preserved:

1. Invariant completeness is unaffected because $\mathcal{I}_1$ injection is
   independent of $\mathrm{Proj}$.
2. Soft invariant order preservation is unaffected because
   $\mathcal{I}_2^{*}$ is unchanged.
3. Partition integrity is preserved because
   $\mathcal{C}_{\mathrm{rec}}\subseteq\mathcal{V}_{\mathrm{rest}}$ and
   $\mathcal{S}^*\subseteq\mathcal{C}_{\mathrm{pool}}
   \subseteq\mathcal{V}_{\mathrm{rest}}$.
4. Mandatory recent-tail completeness is unaffected because
   $T_{\mathrm{base}}\subseteq T_{\mathrm{recent}}$ remains independent of
   $\mathrm{Proj}$.
5. Score boundedness is preserved because
   $S_{\mathrm{proj}}(d,\mathcal{S},q)\in[0,1]$.
6. Token budget respect is preserved because the result still flows through the
   same residual variant budget and greedy token packing contract.
7. Compaction boundary safety is preserved because
   $\mathcal{S}^*\subseteq\mathcal{V}_{\mathrm{rest}}$.
8. Hop termination is unchanged because $\mathcal{C}_{hop}^{*}(q)$ is defined
   identically.
9. Edge-case safety is preserved by the guards below.

Edge-case additions:

- $\mathcal{C}_{\mathrm{pool}}(q)=\emptyset$: the greedy selector returns
  $\mathcal{S}^*=\emptyset$ and $\mathrm{Proj}$ reduces to
  $\mathcal{C}_{hop}^{*}(q)$ only.
- $|E(q)|=0$: the denominator in $\Delta\Phi$ uses $\max(|E(q)|,1)$, so no
  division by zero is possible.
- $\xi(q)<\theta_\xi$: the conditional routes directly to the existing
  $\mathcal{C}_2(q)\cup\mathcal{C}_{hop}^{*}(q)$ behavior.
- $\tau_{\mathcal{V}}(q)=0$: the selector may compute $\mathcal{S}^*$, but
  packing injects zero documents and the budget invariant still holds.

### 9.10 Symbol Table (Section 9 Additions)

| Symbol | Domain | Meaning |
| --- | --- | --- |
| $\xi(q)$ | $[0,1]$ | Temporal-compositional query indicator |
| $\theta_\xi$ | $(0,1)$ | Activation threshold for temporal mode |
| $\theta_{\xi}^{\mathrm{norm}}$ | $(0,\infty)$ | Saturation normalization for $\xi$ |
| $A(d)$ | $[0,1]$ | Temporal anchor density of document $d$ |
| $\theta_A^{\mathrm{norm}}$ | $(0,\infty)$ | Saturation normalization for $A$ |
| $E(q)$ | ordered tuple set | Event-slot sequence extracted from $q$ |
| $\phi_j(d)$ | $\{0,1\}$ | Binary slot-match indicator |
| $\theta_e$ | $[-1,1]$ | Slot-match similarity threshold |
| $\Delta\Phi(d,\mathcal{S},q)$ | $[0,1]$ | Marginal event-slot coverage |
| $\mu,\nu,\rho$ | $[0,1]$, sum to 1 | Coverage score weights |
| $S_{\mathrm{cov}}(d,\mathcal{S},q)$ | $[0,1]$ | Coverage-augmented score |
| $S_{\mathrm{proj}}(d,\mathcal{S},q)$ | $[0,1]$ | Final blended projection score |
| $\mathcal{C}_{\mathrm{rec}}(q)$ | $\subseteq\mathcal{V}_{\mathrm{rest}}$ | Recovery candidate set |
| $\theta_{\mathrm{rec}}$ | $[-1,1]$ | Semantic floor for recovery pass |
| $k_{\mathrm{rec}}$ | $\mathbb{Z}_{>0}$ | Recovery set size cap |
| $\mathcal{C}_{\mathrm{pool}}(q)$ | $\subseteq\mathcal{V}_{\mathrm{rest}}$ | Combined greedy input pool |
| $k_{\mathrm{cov}}$ | $\mathbb{Z}_{>0}, \le k_2$ | Maximum anchor turns to select |
| $\theta_{\mathrm{stop}}$ | $[0,1]$ | Early-stop floor for greedy selector |
| $\mathcal{S}^*(q)$ | $\subseteq\mathcal{C}_{\mathrm{pool}}$ | Greedy-selected coverage-aware anchor set |

### 9.11 Relationship to Existing Sections

This section is an extension, not a replacement:

- Section 1 hybrid score $\mathrm{score}(d)$ is unchanged and still feeds
  $S_{\mathrm{final}}(d)$ as before.
- Section 7.5 $S_{\mathrm{final}}(d)$ is the first input to
  $S_{\mathrm{proj}}$; when $\xi(q)=0$, the two are identical.
- Section 7.7 hop expansion $\mathcal{C}_{hop}^{*}$ is unchanged and is
  unioned with $\mathcal{S}^*$ exactly as before.
- Section 7.8 budget arithmetic is unchanged; $\mathrm{Proj}$ is still bounded
  by $\tau_{\mathcal{V}}(q)$ and still greedy-packed.
- [`gating.md`](./gating.md) inspired the saturating-sum pattern for $\xi(q)$,
  but the two operate on different objects and at different pipeline stages.
- [`ast-v2.md`](./ast-v2.md) Section 7's document-addressed cache $\Psi$ should
  be extended to store the precomputed $A(d)$ value alongside existing tier and
  budget metadata.
