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

## 6. Why This Complements Retrieval

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

## 7. Runtime Invariants

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

## 8. Practical Interpretation

In practical terms, continuity for this system is:

$$
\text{continuity} =
\text{authored rules}
+ \text{recent exact session state}
+ \text{older retrieved memory}
$$

This avoids the failure mode where continuity depends entirely on a semantic
summary being perfect.
