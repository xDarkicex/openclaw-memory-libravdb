# Documentation Index

Versioned `*-v*` design docs are the reviewed authoritative references when a
legacy non-versioned predecessor also exists. Older non-versioned docs are kept
to preserve project history and design evolution.

- [installation.md](./installation.md) - Complete install, activation, verification, and troubleshooting reference.
- [architecture.md](./architecture.md) - End-to-end component model, turn lifecycle, compaction flow, and degraded behavior.
- [problem.md](./problem.md) - Technical argument for replacing the stock OpenClaw memory lifecycle in this use case.
- [mathematics-v2.md](./mathematics-v2.md) - Formal reference for hybrid scoring, decay, token budgeting, Matryoshka retrieval, compaction, and planned two-pass retrieval.
- [compaction-evaluation.md](./compaction-evaluation.md) - Real-model benchmark notes for T5 summary confidence, Nomic-space preservation, and the hard preservation gate.
- [continuity.md](./continuity.md) - Continuity model for invariant context, preserved recent raw session tail, and retrieved older memory.
- [ast-v2.md](./ast-v2.md) - Reviewed authoritative AST partitioning reference for authored Markdown hard invariants, soft invariants, and variant lore.
- [ast.md](./ast.md) - Historical predecessor to `ast-v2.md`, kept to show design evolution and earlier bugs.
- [gating.md](./gating.md) - Full derivation and calibration guide for the domain-adaptive gating scalar.
- [implementation.md](./implementation.md) - Non-obvious implementation decisions and their rationale.
- [dependencies.md](./dependencies.md) - Why LibraVDB and slab-based storage were chosen for this plugin.
- [models.md](./models.md) - ONNX model strategy, latency trade-offs, and shipped model roles.
- [security.md](./security.md) - Security model, untrusted-memory framing, isolation guarantees, and deletion boundaries.
- [contributing.md](./contributing.md) - Contributor workflow, prerequisites, and invariant test expectations.
- [architecture-decisions/README.md](./architecture-decisions/README.md) - Index of the repository ADRs.
- [embedding-profiles.md](./embedding-profiles.md) - Shipped embedding profile baseline and current profile metadata.
