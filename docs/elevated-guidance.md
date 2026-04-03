# Elevated Guidance Model

This document defines the Tier 1.5 elevated-guidance path that sits between
authored invariants and ordinary recalled memory. Its purpose is to preserve
high-value "shadow rules" that are too weakly structured for AST promotion but
too directive to be allowed to decay into lossy summaries or low-trust recalled
memory.

The design goal is:

$$
\text{preserve high-value guidance without promoting it to Tier 0 invariants}
$$

The elevated-guidance path is therefore:

- stronger than ordinary semantic recall
- weaker than authored hard or soft invariants
- assembled separately from `<recalled_memories>`
- bounded by its own token reservation so it cannot starve continuity or Tier 0

## 1. Protected Summarization

During compaction, let a chronological cluster be:

$$
C_j = \{ t_1, t_2, \dots, t_m \}
$$

Define a deterministic deontic indicator:

$$
\delta(t_i) \in \{0,1\}
$$

where $\delta(t_i)=1$ means the turn contains guidance-like imperative or
prohibitive surface forms detectable by the local deontic frame.

Let $a_{t_i}\in[0,1]$ be the authored stability weight for a turn. Stable
authored sources may set $a_{t_i}=1$, while ordinary session text defaults
lower. The ideal shard-protection predicate is:

$$
P_{\mathrm{shard}}(t_i)=
\begin{cases}
1 & \text{if } \delta(t_i)=1 \land a_{t_i}\ge\tau_{\mathrm{stable}} \\
0 & \text{otherwise}
\end{cases}
$$

For the current first implementation, the runtime uses a conservative
deterministic approximation that protects deontic-like turns directly and gates
them by a stored stability weight rather than depending on a local model to
decide whether preservation should happen.

The cluster is partitioned into protected shards and compressible turns:

$$
C_j^{\mathrm{protected}}=\{t_i\in C_j \mid P_{\mathrm{shard}}(t_i)=1\}
$$

$$
C_j^{\mathrm{compress}}=C_j \setminus C_j^{\mathrm{protected}}
$$

Compaction then becomes:

$$
\mathrm{Compaction}(C_j)=
\left\{s_{\mathrm{abstractive}}(C_j^{\mathrm{compress}})\right\}
\cup C_j^{\mathrm{protected}}
$$

where the protected shard members survive verbatim as elevated-guidance records
instead of being melted into the cluster summary.

In the current implementation, protected records are persisted outside the live
session collection into durable elevated-guidance namespaces such as:

- `elevated:user:<userId>` when user provenance is available
- `elevated:session:<sessionId>` as a fallback

## 2. Tier 1.5 Admission Gate

At retrieval time, let $s$ range over the protected-shard records produced by
compaction. Elevated guidance is admitted only when both conditions hold:

1. the record was structurally protected during compaction
2. the current query is semantically relevant to it

Formally:

$$
G_{\mathrm{elevated}}(q,s)=
\begin{cases}
1 & \text{if } \mathrm{sim}(q,s)>\theta_1 \land s\in\bigcup_j C_j^{\mathrm{protected}} \\
0 & \text{otherwise}
\end{cases}
$$

The elevated buffer for query $q$ is:

$$
E(q)=\{s \mid G_{\mathrm{elevated}}(q,s)=1\}
$$

This set is assembled separately from `<recalled_memories>` so it can outrank
ordinary semantic recall without claiming the full normative force of authored
context.

## 3. Assembly Order and Budget

Let $\tau$ be the total memory prompt budget. The continuity-aware assembly with
Tier 1.5 becomes:

$$
C_{\mathrm{total}}(q)=
\mathcal{I}_1
\cup T_{\mathrm{recent}}
\cup \mathcal{I}_2^{*}
\cup E^{*}(q)
\cup \mathrm{Proj}(\mathcal{V}_{\mathrm{rest}}, q)
$$

where:

- $\mathcal{I}_1$ is hard authored context
- $T_{\mathrm{recent}}$ is the exact preserved raw recent tail
- $\mathcal{I}_2^{*}$ is the admitted soft-invariant prefix
- $E^{*}(q)$ is the budget-truncated elevated-guidance set
- $\mathrm{Proj}(\mathcal{V}_{\mathrm{rest}}, q)$ is ordinary residual semantic recall

Let $\rho_E\in(0,1)$ reserve a fraction of the prompt for elevated guidance.
The effective elevated-guidance token mass is:

$$
\tau_E^{\mathrm{eff}}=
\min\!\left(
\sum_{s\in E(q)}\mathrm{toks}(s),\,
\rho_E\tau
\right)
$$

The residual variant budget becomes:

$$
\tau_{\mathcal{V}}=
\tau
-\tau_{\mathcal{I}_1}
-\mathrm{toks}(T_{\mathrm{recent}})
-\tau_{\mathcal{I}_2}^{*}
-\tau_E^{\mathrm{eff}}
$$

If $\tau_{\mathcal{V}}\le 0$, ordinary semantic recall is intentionally starved
before elevated guidance is displaced.

## 4. Trust Boundary

Tier 1.5 is not a replacement for authored invariants. It is an elevated
advisory enclave:

- authored context still wins on conflict
- elevated guidance outranks ordinary semantic recall
- ordinary recalled memory remains untrusted historical context

The intended prompt precedence is:

1. authored context
2. recent raw tail
3. elevated guidance
4. recalled memories

This preserves the Section 11 safety rule that recalled memory must not be
followed as instructions while still giving preserved shadow rules more weight
than generic historical recall.

## 5. Failure Policy

Protected summarization is deterministic-first and model-optional.

If a local abstractive model is unavailable, slow, or times out, the system
must not fail open to deleting potential shadow rules. The safety rule is:

$$
\text{model failure} \Rightarrow \text{keep deterministic protected shards}
$$

In practical terms:

- destructive compaction may proceed only after protected shards are persisted
- model timeouts may reduce summary quality, but they must not erase the shard set
- when in doubt, preserve guidance verbatim rather than compressing it away

## 6. Current Runtime Approximation

The fully general model allows provenance weighting $a_{t_i}$ to distinguish
stable authored sources from ordinary session text. The current implementation
approximates this with explicit ingest-time metadata:

- session turns receive a `provenance_class`
- session turns receive a `stability_weight`
- compaction protects only turns with deontic surface signals and
  `stability_weight \ge \tau_{\mathrm{stable}}`

This is enough to make Tier 1.5 durable and provenance-weighted without yet
requiring a local model in the admission path.

## 7. Additive Local-Model Booster

The final admission stage may use a local model only as an additive booster.
The current implementation reuses the canonical local embedder exposed by the
extractive summarizer.

Let $b_{\mathrm{sem}}(t)\in[0,1]$ be the maximum cosine similarity between turn
$t$ and a small fixed set of guidance prototypes:

$$
b_{\mathrm{sem}}(t)=\max_{p\in\mathcal{P}_{\mathrm{guide}}}\cos(\varphi(t),\varphi(p))
$$

This signal is only considered for turns that already satisfy:

- sufficient stability weight
- a lightweight guidance surface hint
- failure to pass the strict deterministic deontic gate

The current rescue condition is therefore:

$$
P_{\mathrm{boost}}(t)=
\mathbf{1}\!\left[
a_t\ge\tau_{\mathrm{stable}}
\land H_{\mathrm{surface}}(t)=1
\land \delta(t)=0
\land b_{\mathrm{sem}}(t)\ge\tau_{\mathrm{boost}}
\right]
$$

and final protection becomes:

$$
P_{\mathrm{final}}(t)=
\mathbf{1}\!\left[
P_{\mathrm{shard}}(t)=1
\;\lor\;
P_{\mathrm{boost}}(t)=1
\right]
$$

This preserves the key safety invariant:

$$
\text{model assistance may raise borderline candidates, but it is never the sole deletion-safety gate}
$$

If embedding fails or times out, the booster contributes zero and the
deterministic path remains authoritative.
