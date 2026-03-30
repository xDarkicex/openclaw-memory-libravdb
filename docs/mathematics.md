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

and let the query space be:

$$
\mathbf{Q}
$$

Let the embedding function:

$$
\varphi : \mathbf{D}\cup\mathbf{Q}\rightarrow \mathbb{R}^m
$$

map documents and queries to unit vectors:

$$
\|\varphi(x)\| = 1 \qquad \forall x \in \mathbf{D}\cup\mathbf{Q}
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
\alpha_r+\alpha_f+\alpha_a=1
$$

where:

$$
r(d)=\exp\left(-\lambda_r\cdot \Delta t(d)\right)
$$

$$
f(d)=\frac{\log(1+\operatorname{acc}(d))}{\log\left(1+\max_{d'\in\mathcal{V}}\operatorname{acc}(d')\right)}
$$

$$
a(d)\in[0,1]
$$

This lets the planned discovery score incorporate recency, access frequency,
and authored authority without baking those concerns into the raw cosine term.

### 7.4 Pass 1: Coarse Semantic Filtering

Pass 1 computes cosine similarity:

$$
\operatorname{sim}(q,d)=\varphi(q)^\top \varphi(d)
$$

and selects the coarse candidate set:

$$
\mathcal{C}_1(q)=\operatorname{top\text{-}k_1}_{d\in\mathcal{V}}\ \operatorname{sim}(q,d)
$$

with a hard similarity floor:

$$
\mathcal{C}_1(q)=\{d\in\mathcal{C}_1(q)\mid \operatorname{sim}(q,d)\ge \theta_1\}
$$

The purpose of this pass is breadth with cheap semantic recall. Documents below
$\theta_1$ are rejected even if they land in the top-$k_1$ set, because the
first pass must not admit semantically orthogonal noise into second-pass work.

### 7.5 Pass 2: Normalized Hybrid Scoring

Let the query keyword extractor return:

$$
K = \operatorname{KeyExt}(q)
$$

and define normalized keyword coverage:

$$
M_{norm}(K,d)=\frac{|K\cap \operatorname{terms}(d)|}{|K|}\in[0,1]
$$

The proposed normalized second-pass score is:

$$
S_{final}(d)=
\frac{
\omega(d)\cdot\max(\operatorname{sim}(q,d), 0)\cdot\left(1+\kappa\cdot M_{norm}(K,d)\right)
}{
1+\kappa
}
$$

The normalized second-pass score form above was suggested during design review
by GitHub contributor [@JuanHuaXu](https://github.com/JuanHuaXu). The broader
two-pass architecture in this section remains project-authored.

This form is preferred over a hard clamp such as $\min(\mathrm{term},1)$
because clamping discards ranking information at the high end of the score
distribution. The denominator $(1+\kappa)$ gives an analytic bound instead of
truncating the result.

The second-pass candidate set is:

$$
\mathcal{C}_2(q)=\operatorname{top\text{-}k_2}_{d\in\mathcal{C}_1(q)}\ S_{final}(d)
$$

with:

$$
k_2 \le k_1
$$

### 7.6 Bounded Range and Interpretation of $\kappa$

Let:

$$
s=\max(\operatorname{sim}(q,d),0)\in[0,1]
$$

Then:

$$
S_{final}(d)=\frac{\omega(d)\cdot s\cdot(1+\kappa M_{norm}(K,d))}{1+\kappa}
$$

The numerator is maximized when $s=1$ and $M_{norm}(K,d)=1$:

$$
\max(\text{numerator})=\omega(d)\cdot(1+\kappa)
$$

Therefore:

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
\mathcal{G}=(\mathbf{D}, E)
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
\lambda\cdot
\max_{d\in\mathcal{C}_2(q),\ d'\in H(d)} S_{final}(d)
$$

with hop decay:

$$
\lambda\in(0,1)
$$

and filtered hop set:

$$
\mathcal{C}_{hop}^{*}(q)=\{d'\in\mathcal{C}_{hop}(q)\mid S_{hop}(d')\ge\theta_{hop}\}
$$

### 7.8 Final Assembly Under a Token Budget

Variant projection is:

$$
\operatorname{Proj}(\mathcal{V}, q)=\mathcal{C}_2(q)\cup\mathcal{C}_{hop}^{*}(q)
$$

Total injected soul context is:

$$
C_{soul}(q)=\mathcal{I}\cup \operatorname{Proj}(\mathcal{V}, q)
$$

Let the total prompt budget be $\tau$. If the invariant set consumes:

$$
\tau_{\mathcal{I}}=\sum_{d\in\mathcal{I}} \operatorname{toks}(d)
$$

then the variant budget is:

$$
\tau_{\mathcal{V}}=\tau-\tau_{\mathcal{I}}
$$

Documents in $\operatorname{Proj}(\mathcal{V}, q)$ are injected in descending
score order until:

$$
\sum_{d\in \text{injected}} \operatorname{toks}(d)\le\tau_{\mathcal{V}}
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
\forall d\in\mathcal{I},\ \forall q\in\mathbf{Q}: d\in C_{soul}(q)
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
\sum_{d\in C_{soul}(q)} \operatorname{toks}(d)\le\tau
$$

with the invariant set never truncated

5. Hop termination:

The authored hop graph should be acyclic, or the runtime must cap hop depth at
one to guarantee termination.
