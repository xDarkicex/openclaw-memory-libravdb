# Mathematical Reference

This document is the formal reference for the scoring and optimization math used
by the plugin. The gating scalar is documented separately in
[gating.md](./gating.md). The continuity model and recent-tail preservation
layer are documented in [continuity.md](./continuity.md). The authored
invariant/variant partitioning rules are documented in
[ast-v2.md](./ast-v2.md). Earlier non-versioned math docs are preserved for
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
0.6 & \text{if } d \text{ is from durable user memory} \\
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

The design convention is that $\alpha + \beta + \gamma = 1$. This keeps the
base score on a stable scale and makes tuning interpretable: increasing one
weight means explicitly decreasing another.

**Note on retrieval similarity.** The term $\cos(q,d) \in [0,1]$ represents the
similarity score as bounded and returned by the host retrieval layer. The planned
two-pass system in Section 7 uses raw cosine similarity spanning $[-1,1]$ with
negatives clipped explicitly. These are described separately to avoid conflating
current implementation with planned architecture.

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
- durable user memory: $\lambda_s = 0.00001$
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

This makes session context fade fastest, user memory fade more slowly, and
global memory remain the most stable.

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
4. derive cluster count:

**Precondition:** the target cluster size must satisfy $k \ge 1$. The case
$k = 0$ is undefined and must cause startup or configuration validation failure.

Let $n$ be the number of eligible turns. The cluster count is:

$$
c = \left\lceil \frac{\max(n,\,1)}{k} \right\rceil
$$

5. assign turn $i$ to cluster:

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

## 7. Planned Two-Pass Discovery Scoring

This section documents the planned scoring and assembly model for a future
two-pass retrieval system. It is a design target for optimization work after
the OpenClaw `2026.3.28+` memory prompt contract change. It is **not** the
current implementation in [`src/scoring.ts`](../src/scoring.ts) or
[`src/context-engine.ts`](../src/context-engine.ts).

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

The planned gating function is:

$$
G : \mathbf{Q}\times\mathbf{D}\rightarrow \{0,1\}
$$

and determines whether a document is injected for a query.

### 7.2 Corpus Decomposition

The corpus is partitioned into invariant and variant sets:

$$
\mathbf{D} = \mathcal{I}\cup\mathcal{V},
\qquad
\mathcal{I}\cap\mathcal{V}=\emptyset
$$

The invariant membership predicate is:

$$
\iota : \mathbf{D}\rightarrow \{0,1\}
$$

with:

$$
\mathcal{I} = \{d\in\mathbf{D}\mid \iota(d)=1\}
$$

and:

$$
\mathcal{V} = \mathbf{D}\setminus\mathcal{I}
$$

For OpenClaw, the intended implementation is that invariant documents are
registered as authored constants at load time rather than discovered at query
time. In practice, this means documents such as `AGENTS.md` and `souls.md`
should be compiled into the invariant set when they are explicitly marked as
always-inject rules.

The required invariant is:

$$
\iota(d)=1 \Rightarrow G(q,d)=1 \qquad \forall q\in\mathbf{Q}
$$

This is a compile-time guarantee, not a runtime heuristic.

### 7.3 Document Authority Weight

Each variant document carries a precomputed authority weight:

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
f(d)=\frac{\log(1+\mathrm{acc}(d))}{\log\!\left(1+\max_{d'\in\mathcal{V}}\mathrm{acc}(d')+1\right)}
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
$\max_{d'\in\mathcal{V}}\mathrm{acc}(d') = 0$, the denominator equals $\log 2$
and:

$$
f(d) = 0 \qquad \forall d\in\mathcal{V}
$$

cleanly deferring frequency weight to $r(d)$ and $a(d)$ until access history
accumulates.

Because $r(d)\in(0,1]$, $f(d)\in[0,1]$, and $a(d)\in[0,1]$, and $\omega(d)$
is a convex combination of these terms:

$$
\omega(d)\in[0,1]
$$

This lets the planned discovery score incorporate recency, access frequency,
and authored authority without baking those concerns into the raw cosine term.

### 7.4 Pass 1: Coarse Semantic Filtering

Pass 1 computes cosine similarity:

$$
\mathrm{sim}(q,d)=\varphi(q)^\top \varphi(d) \in [-1,1]
$$

The raw top-$k_1$ candidate set is:

$$
\mathcal{C}_1^{\mathrm{raw}}(q)=\mathrm{TopK}_{d\in\mathcal{V}}\!\left(k_1,\,\mathrm{sim}(q,d)\right)
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
\mathrm{Proj}(\mathcal{V},\, q)=\mathcal{C}_2(q)\cup\mathcal{C}_{hop}^{*}(q)
$$

Total injected soul context is:

$$
C_{soul}(q)=\mathcal{I}\cup \mathrm{Proj}(\mathcal{V},\, q)
$$

Let the total prompt budget be $\tau$. If the invariant set consumes:

$$
\tau_{\mathcal{I}}=\sum_{d\in\mathcal{I}} \mathrm{toks}(d)
$$

then the variant budget is:

$$
\tau_{\mathcal{V}}=\tau-\tau_{\mathcal{I}}
$$

**Required startup invariant:**

$$
\tau_{\mathcal{I}} \le \tau
$$

This must be enforced at startup or configuration validation time. If violated,
the system cannot simultaneously satisfy "the invariant set is never truncated"
and "total injected tokens do not exceed the total budget." Initialization must
fail or the deployment must be reconfigured.

Documents in $\mathrm{Proj}(\mathcal{V}, q)$ are injected in descending
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
1 & \text{if } \iota(d)=1 \\
\mathbf{1}[d\in\mathcal{C}_2(q)\cup\mathcal{C}_{hop}^{*}(q)] & \text{if } \iota(d)=0
\end{cases}
$$

### 7.10 Required Runtime Invariants

The implementation must preserve these properties:

1. Invariant completeness:

$$
\forall d\in\mathcal{I},\; \forall q\in\mathbf{Q}: d\in C_{soul}(q)
$$

2. Partition integrity:

$$
\mathcal{I}\cap\mathcal{V}=\emptyset
$$

3. Score boundedness:

$$
S_{final}(d)\in[0,1]
$$

4. Token budget respect:

$$
\sum_{d\in C_{soul}(q)} \mathrm{toks}(d)\le\tau
$$

with the invariant set never truncated, which is satisfiable only because the
startup invariant $\tau_{\mathcal{I}}\le\tau$ is required.

5. Hop termination:

The authored hop graph should be acyclic, or the runtime must cap hop depth at
one to guarantee termination.

6. Edge-case safety:

No valid input in the declared domain may produce a NaN, a negative score, or a
division-by-zero. This includes at minimum:

- cold-start corpus with $\max \mathrm{acc}=0$
- empty extracted keyword set with $|K|=0$
- zero eligible clustering turns with $n=0$
- near-zero-norm Matryoshka prefix vectors
- empty hop neighborhoods

7. Quality multiplier boundedness:

$$
\mathrm{confidence}(s)\in[0,1],
\qquad
Q(d)\in[1-\delta,\,1]\subseteq[0,1]
$$

for all valid inputs with $\delta\in[0,1]$.
