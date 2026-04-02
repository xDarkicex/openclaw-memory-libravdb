# TITLE: Mathematical Reference - Abstract Syntax Tree (AST) Partitioning

Historical note: this document is preserved to show the project's design
evolution. The reviewed authoritative AST reference is
[`ast-v2.md`](./ast-v2.md).

This document formalizes the heuristic mapping of user-authored Markdown documents (such as `agents.md` and `souls.md`) into the partitioned sets required by the two-pass retrieval system. It serves as the bridge between raw text ingestion and the rigorous corpus decomposition defined in `mathematics-v2.md` Section 7.2.

The design goal is to extract rigid behavioral rules (the invariant set) from contextual lore (the variant set) automatically, using structural types as a mathematically stable proxy for user intent. 

## 1. The Document AST and Node Extraction

Let a raw Markdown document $d_{\mathrm{raw}}$ be parsed into an Abstract Syntax Tree $\mathcal{T}$. 
Let $E: \mathcal{T} \to N_d$ be an extraction function that flattens the tree into an ordered sequence of semantic leaf nodes $N_d = \langle n_1, n_2, \dots, n_k \rangle$. 

Each node $n_i \in N_d$ has an associated structural kind assigned by the parser (e.g., `yuin/goldmark`), mapped by the function $\kappa: N_d \to K$, where $K$ is the set of supported Markdown node types:
\[ K = \{ \text{Paragraph}, \text{List}, \text{Blockquote}, \text{YAMLFrontmatter}, \text{Heading}, \dots \} \]

*Implemented in `sidecaragentparser.go`.*

## 2. The Structural Indicator Function $\iota$

To avoid document-level monolithic injection, we redefine the invariant membership predicate from `mathematics-v2.md` Section 7.2 at the node level. 

Let $K_{\mathcal{I}} \subset K$ be the subset of node kinds structurally correlated with hard constraints, core directives, and programmatic definitions:
\[ K_{\mathcal{I}} = \{ \text{List}, \text{Blockquote}, \text{YAMLFrontmatter} \} \]

We define the structural indicator function $\iota: N_d \to \{0,1\}$ as:
\[
\iota(n) = \begin{cases} 
1 & \text{if } \kappa(n) \in K_{\mathcal{I}} \\ 
0 & \text{otherwise} 
\end{cases}
\]

**Note on structural proxy limits:** This heuristic relies entirely on the probability that human authors place absolute rules in lists/frontmatter and narrative lore in standard paragraphs. It is mathematically blind to the semantic meaning of the text.

## 3. Corpus Decomposition and Set Integration

For any document $d \in \mathbf{D}_{\text{agents}} \cup \mathbf{D}_{\text{souls}}$, the node set $N_d$ is partitioned cleanly:
- **The Core Directives (Invariant):** $\mathcal{I}_d = \{ n \in N_d \mid \iota(n) = 1 \}$
- **The Contextual Lore (Variant):** $\mathcal{V}_d = \{ n \in N_d \mid \iota(n) = 0 \}$

This guarantees partition integrity:
\[ \mathcal{I}_d \cup \mathcal{V}_d = N_d \quad \text{and} \quad \mathcal{I}_d \cap \mathcal{V}_d = \emptyset \]

These sets feed directly into the global corpus partitioning:
\[ \mathcal{I} = \bigcup_{d} \mathcal{I}_d \qquad \mathcal{V} = \mathbf{D}_{\text{standard}} \cup \left( \bigcup_{d} \mathcal{V}_d \right) \]

By definition, any chunk $n \in \mathcal{I}_d$ inherits the hard startup guarantee from `mathematics-v2.md` Section 7.1:
\[ \iota(n)=1 \implies G(q,n)=1 \quad \forall q \in \mathbf{Q} \]

## 4. Authored Authority Boost for Variant Lore

Chunks in $\mathcal{V}_d$ (such as standard paragraph nodes) lose their invariant guarantee and must survive the Pass 1 coarse semantic filter defined in `mathematics-v2.md` Section 7.4.

To ensure that agent-specific lore outcompetes general conversational memory during Pass 2, we enforce a strict authority override. For all $n \in \mathcal{V}_d$ extracted from a core identity document:
\[ a_n = 1.0 \]

Following the authority weight convex combination $d_{\omega}$ from `mathematics-v2.md` Section 7.3, this guarantees that variant chunks of core files receive the maximum possible authored weight when scoring against the remaining token budget $\tau_{\mathcal{V}}$.

## 5. Token Budget Safety Bounds

Because invariants bypass all truncation (Section 7.8), an adversarial or malformed file containing an excessively large list block could violate the token budget:
\[ \sum_{n \in \mathcal{I}_d} \mathrm{toks}(n) > \tau \]

Therefore, the system must enforce a load-time safety bound on the extracted AST invariants:
\[ \tau_{\text{max\_invariant}} \le \alpha \tau \quad \text{where } \alpha \in (0, 1) \]

If parsing yields an $\mathcal{I}_d$ that exceeds $\alpha \tau$ (e.g., $\alpha = 0.4$, reserving 60% of context for variant history and tools), the parser must fast-fail and reject the agent load. This protects the runtime invariants dictated in `mathematics-v2.md` Section 7.10 from mathematically impossible token fits.
