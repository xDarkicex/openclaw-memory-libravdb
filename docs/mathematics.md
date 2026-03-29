# Mathematical Reference

This document is the formal reference for the scoring and optimization math used
by the plugin. The gating scalar is documented separately in
[gating.md](./gating.md).

Every formula below points at the file that currently implements it. If the code
changes first, this document must change with it.

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
R(d) = e^{-\lambda(d)\Delta t_d}
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

Boundary cases:

- $\alpha = 1$ collapses to semantic retrieval only.
- $\beta = 1$ collapses to pure recency preference.
- $\gamma = 1$ collapses to scope-only ranking and is almost always wrong
  because it ignores content.
- $\delta = 0$ ignores summary quality completely.
- $\delta = 1$ applies the maximum configured penalty to low-confidence
  summaries.

## 2. Recency Decay

Recency uses exponential decay:

$$
R(d) = e^{-\lambda \Delta t_d}
$$

where $\Delta t_d$ is the age of the record in seconds and $\lambda$ is the
scope-specific decay constant.

Implemented in [`src/scoring.ts`](../src/scoring.ts).

In the current implementation, $\Delta t_d$ is measured in **seconds**, not
milliseconds:

$$
\Delta t_d = \frac{\mathrm{Date.now()} - ts_d}{1000}
$$

and the $\lambda$ values are therefore **per-second** decay constants.

The current implementation uses different constants by scope:

- active session: $\lambda = 0.0001$
- durable user memory: $\lambda = 0.00001$
- global memory: $\lambda = 0.000002$

The implied half-lives make the decay constants auditable at a glance:

| Scope | $\lambda$ | Half-life |
|---|---|---|
| Session | $0.0001$ | $\approx 1.9\ \text{hours}$ |
| User | $0.00001$ | $\approx 19\ \text{hours}$ |
| Global | $0.000002$ | $\approx 4\ \text{days}$ |

$$
t_{1/2} = \frac{\ln 2}{\lambda}
$$

If those half-lives feel wrong for a given deployment, adjust $\lambda$ via
config — do not change the decay formula itself.

This makes session context fade fastest, user memory fade more slowly, and
global memory remain the most stable.

Why exponential instead of linear:

- exponential decay preserves ordering smoothly across many time scales
- it never goes negative
- it gives a natural "fast drop then long tail" shape for conversational relevance

Linear decay has a hard cutoff or requires arbitrary clipping. Exponential decay decays old memories continuously without inventing a discontinuity.

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
bytes-per-token rule:

$$
\widehat{T}_{sidecar}(t)=\max\left(\left\lfloor\frac{\mathrm{len}(t)}{4}\right\rfloor, 1\right)
$$

The two estimators are intentionally different. The host estimator optimizes
prompt-budget accuracy. The sidecar estimator is used only as a stable
normalization denominator in the technical specificity signal $P(t)$ of the
gating scalar. They must not be substituted for each other.

## 4. Matryoshka Cascade

For Nomic embeddings, one full vector $\vec{v} \in \mathbb{R}^{768}$ produces three tiers:

$$
\vec{u}_{64} = \frac{\vec{v}_{1:64}}{\lVert \vec{v}_{1:64} \rVert_2}, \quad
\vec{u}_{256} = \frac{\vec{v}_{1:256}}{\lVert \vec{v}_{1:256} \rVert_2}, \quad
\vec{u}_{768} = \frac{\vec{v}_{1:768}}{\lVert \vec{v}_{1:768} \rVert_2}
$$

Re-normalization is required after truncation because a prefix of a unit vector is not itself a unit vector in general.

Implemented in [`sidecar/embed/matryoshka.go`](../sidecar/embed/matryoshka.go)
and [`sidecar/store/libravdb.go`](../sidecar/store/libravdb.go).

Cascade search uses:

- L1: `64d`
- L2: `256d`
- L3: `768d`

The search exits early when a tier's best score exceeds the configured threshold;
otherwise it falls through to the next tier. Empty lower-tier collections
degrade gracefully because:

$$
\max(\emptyset) = 0
$$

and `0` is below both early-exit thresholds by design.

Backfill condition:

- L3 is the source of truth
- L1 and L2 are derived caches
- if an L1 or L2 insert fails, a dirty-tier marker is recorded
- startup backfill reconstructs the missing tier vector from L3

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

$$
c = \left\lceil \frac{n}{k} \right\rceil
$$

where $n$ is the number of eligible turns
5. assign turn $i$ to cluster:

$$
\mathrm{clusterIndex}(i) = \left\lfloor \frac{i \cdot c}{n} \right\rfloor
$$

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

The confidence term is implemented as a bounded quality signal:

$$
\mathrm{confidence}(s) \in [0,1]
$$

with backend-specific definitions:

$$
\mathrm{confidence}_{extractive}(s) =
\mathrm{mean\ cosine\ similarity\ of\ selected\ turns\ to\ the\ cluster\ centroid}
$$

$$
\mathrm{confidence}_{onnx}(s) =
\exp\left(\frac{\sum_{i=1}^{n}\log p(t_i \mid t_{<i}, C_j)}{n}\right)
$$

where $t_i$ are generated summary tokens and $C_j$ is the source cluster.

The retrieval decay metadata is then:

$$
\mathrm{decay\_rate}(s)=1-\mathrm{confidence}(s)
$$

and the retrieval quality multiplier from Section 1 becomes:

$$
Q(s)=1-\delta\cdot\mathrm{decay\_rate}(s)
$$

At the shipped default $\delta = 0.5$, this constrains summary quality weights
to:

$$
Q(s)\in[0.5,1.0]
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
