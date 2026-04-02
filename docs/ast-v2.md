# TITLE: Mathematical Reference - Abstract Syntax Tree (AST) Partitioning

This document formalizes the heuristic mapping of user-authored Markdown documents (such as `agents.md` and `souls.md`) into the partitioned sets required by the two-pass retrieval system. It serves as the bridge between raw text ingestion and the rigorous corpus decomposition defined in `mathematics-v2.md`.

The design goal is to extract rigid behavioral rules (the invariant sets) from contextual lore (the variant set) automatically. This is achieved using a three-tier structural and semantic proxy, eliminating monolithic injection while protecting user constraints from token-budget starvation.

## 1. The Document AST and Node Extraction

Let a raw Markdown document \(d_{\mathrm{raw}}\) be parsed into an Abstract Syntax Tree \(\mathcal{T}\). 
Let \(E: \mathcal{T} \to N_d\) be an extraction function that flattens the tree into an ordered sequence of semantic leaf nodes \(N_d = \langle n_1, n_2, \dots, n_k \rangle\). 

Each node \(n_i \in N_d\) has an associated structural kind assigned by the parser (e.g., `yuin/goldmark`), mapped by the function \(\kappa: N_d \to K\), where \(K\) is the set of supported Markdown node types:
\[ K = \{ \text{Paragraph}, \text{List}, \text{Blockquote}, \text{YAMLFrontmatter}, \text{Heading}, \dots \} \]

*Implemented in `sidecaragentparser.go`.*

## 2. Formal Deontic Logic (\(\sigma\)) and the Kripke Frame

Structural types alone are insufficient proxies for intent. Narrative lore often resides in paragraphs, but authors frequently place critical instructions there as well (e.g., "You must always answer in JSON"). 

To detect these rules without deep NLP allocations, the parser evaluates raw node bytes against a Kripke Frame \((W, R)\) grounded in Standard Deontic Logic (SDL). 

Let \(\mathcal{B}\) be the set of valid second-person imperative bigrams (e.g., "you must", "never"). A zero-allocation lexer scans the bytes for patterns in \(\mathcal{B}\), mapping them to Modalities (Obligatory, Forbidden, Permitted).

To guarantee logical consistency, the engine enforces Seriality (Axiom D). No world reachable from an Obligatory state may contain a Forbidden obligation on the same action:
\[ O(\phi) \implies \neg F(\text{next}(\phi)) \]

We formalize this as a binary promotion scalar \(\sigma: N_d \to \{0,1\}\). This function is specifically targeted at Paragraph nodes, as structural invariants bypass it:
\[
\sigma(n) = \begin{cases} 
1 & \text{if } \kappa(n) = \text{Paragraph} \land \text{SDL}(\mathcal{B}) \text{ detects a valid imperative} \\ 
0 & \text{otherwise} 
\end{cases}
\]

*Implemented via `NewDeonticFrame` and `EvaluateText` in the zero-allocation byte lexer.*

## 3. The Three-Tier Structural Indicator Function \(\iota\)

To avoid the brittleness of a binary pass/fail budget, we distribute nodes across a three-tier priority hierarchy.

Let \(K_{\mathcal{I}1} \subset K\) be the subset of node kinds that represent hard authorial constraints:
\[ K_{\mathcal{I}1} = \{ \text{List}, \text{YAMLFrontmatter} \} \]

Let \(K_{\mathcal{I}2} \subset K\) be the subset of node kinds that represent soft constraints or stylistic guidelines:
\[ K_{\mathcal{I}2} = \{ \text{Blockquote} \} \]

We define the structural indicator function \(\iota: N_d \to \{0,1,2\}\) mapping each node to a specific tier:
\[
\iota(n) = \begin{cases} 
1 & \text{if } \kappa(n) \in K_{\mathcal{I}1} \quad \text{(Hard Invariant)} \\ 
2 & \text{if } \kappa(n) \in K_{\mathcal{I}2} \lor \sigma(n) = 1 \quad \text{(Soft Invariant)} \\
0 & \text{otherwise} \quad \text{(Variant Lore)}
\end{cases}
\]

*Proof of Reachability:* If a node is a Paragraph, \(\kappa(n) \notin K_{\mathcal{I}1}\) and \(\kappa(n) \notin K_{\mathcal{I}2}\). However, if the deontic lexer detects a rule, \(\sigma(n) = 1\), causing the logical OR condition for \(\iota(n) = 2\) to evaluate to true, successfully promoting the paragraph to a Soft Invariant.

## 4. Corpus Decomposition and Set Integration

For any document \(d \in \mathbf{D}_{\text{agents}} \cup \mathbf{D}_{\text{souls}}\), the node set \(N_d\) is partitioned cleanly into three sets:
- **Hard Directives:** \(\mathcal{I}_{1d} = \{ n \in N_d \mid \iota(n) = 1 \}\)
- **Soft Directives:** \(\mathcal{I}_{2d} = \{ n \in N_d \mid \iota(n) = 2 \}\)
- **Contextual Lore:** \(\mathcal{V}_d = \{ n \in N_d \mid \iota(n) = 0 \}\)

*Partition Completeness:* Because \(\iota(n)\) maps every node to exactly one integer in \(\{0, 1, 2\}\), the resulting sets are mutually exclusive and collectively exhaustive:
\[ \mathcal{I}_{1d} \cup \mathcal{I}_{2d} \cup \mathcal{V}_d = N_d \quad \text{and} \quad \mathcal{I}_{1d} \cap \mathcal{I}_{2d} \cap \mathcal{V}_d = \emptyset \]

These sets integrate into the global corpus. Let \(\mathbf{D}_{\text{standard}}\) be the set of standard memory documents (non-core files). We formally define the standard variant node set as \(\mathcal{V}_{\text{standard}} = \bigcup_{d \in \mathbf{D}_{\text{standard}}} E(d)\). The global corpus is then:
\[ \mathcal{I}_1 = \bigcup_{d} \mathcal{I}_{1d} \qquad \mathcal{I}_2 = \bigcup_{d} \mathcal{I}_{2d} \qquad \mathcal{V} = \mathcal{V}_{\text{standard}} \cup \left( \bigcup_{d} \mathcal{V}_d \right) \]

By definition, any chunk \(n \in \mathcal{I}_{1d}\) inherits the hard startup injection guarantee from `mathematics-v2.md`. To clarify, \(G(q,n)\) represents the runtime *gating admission scalar*, not semantic relevance.
\[ \iota(n)=1 \implies G(q,n)=1 \quad \forall q \in \mathbf{Q} \]

## 5. Authored Authority Boost for Variant Lore

Chunks in \(\mathcal{V}_d\) lose their invariant injection guarantee and must survive semantic vector retrieval. To ensure that agent-specific lore outcompetes general conversational memory, we enforce a strict authority override. For all \(n \in \mathcal{V}_d\) extracted from a core identity document:
\[ a_n = 1.0 \]
This guarantees that variant chunks of core files receive the maximum possible authored weight when scoring against the remaining token budget \(\tau_{\mathcal{V}}\).

## 6. Token Budget Safety Bounds

Adversarial or malformed files containing excessively large constraint blocks could violate the strict prompt limits defined by the host. The system enforces split load-time bounds:

For Hard Invariants (\(\alpha_1\)):
\[ \sum_{n \in \mathcal{I}_{1d}} \mathrm{toks}(n) \le \alpha_1 \tau \implies \text{fast-fail and reject agent load if exceeded} \]

For Soft Invariants (\(\alpha_2\)):
\[ \sum_{n \in \mathcal{I}_{2d}} \mathrm{toks}(n) \le \alpha_2 \tau \implies \text{truncate by position if exceeded} \]

*Cumulative Verification Proof:* Let the total reserved invariant budget fraction be \(\alpha\), where \(\alpha_1 + \alpha_2 \le \alpha\). If both independent enforcement bounds are satisfied, then:
\[ \sum_{n \in \mathcal{I}_{1d}} \mathrm{toks}(n) + \sum_{n \in \mathcal{I}_{2d}} \mathrm{toks}(n) \le \alpha_1 \tau + \alpha_2 \tau = (\alpha_1 + \alpha_2)\tau \le \alpha \tau \]
This mathematically guarantees the overall token budget \(\tau\) is never breached by the combined invariant sets.

## 7. The Document-Addressed Cache (\(\Psi\)) and Runtime Implications

The AST extraction, Deontic bigram evaluation, and partition logic are purely deterministic functions of \(d_{\mathrm{raw}}\). To prevent \(O(N)\) recomputation on every conversational turn, the system maintains a document-addressed cache:

\[ \Psi: \text{hash}(d_{\mathrm{raw}}, \text{tokenizer\_id}) \to \{\mathcal{I}_{1d}, \mathcal{I}_{2d}, \mathcal{V}_d, \text{budget}\} \]

Because the token estimator function \(\lceil \frac{|t|}{\chi(t)} \rceil\) depends on the active model tokenizer, \(\text{tokenizer\_id}\) is embedded in the hash key. 

At runtime:
1. **Tier 1 (\(\mathcal{I}_{1d}\))** is injected via an \(O(1)\) memory copy.
2. **Tier 2 (\(\mathcal{I}_{2d}\))** is evaluated via an \(O(|\mathcal{I}_{2d}|)\) prefix sum to enforce position truncation.
3. **Tier 0 (\(\mathcal{V}_d\))** bypasses re-parsing and feeds directly into the semantic Pass 1 vector retrieval.
