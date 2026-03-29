# Dependency Rationale

## LibraVDB over LanceDB

LibraVDB was chosen as the vector store because the plugin needs more than a single-table embedding lookup.

Key reasons:

- collection-level namespacing for:
  - `session:*`
  - `turns:*`
  - `user:*`
  - `global`
- delete and batch-delete operations used by compaction
- local-first Go-native operation with no Python bridge or remote service dependency
- retrieval infrastructure compatible with HNSW and future IVF/PQ-oriented layering

LanceDB was the natural alternative. It is a solid choice for straightforward durable vector retrieval, but using it here would still have required additional machinery around:

- scope isolation
- delete-heavy compaction flows
- local-first lifecycle management around a multi-scope memory design

The decision was therefore about operational fit, not abstract preference.

## Slabby

The LibraVDB profiling work showed that this workload is allocation-sensitive, especially in repeated insert/search paths over vector-heavy collections.

Slab-style raw-vector storage was selected because:

- vectors are fixed-size payloads
- collections grow in bursty append patterns
- compaction and search create pressure on allocation churn

The measured conclusion from the internal profiling pass was that slab-backed raw-vector storage was performance-competitive with the plain in-memory backend while making allocation behavior more predictable. The main trade-off is reserved-but-unused capacity, which is acceptable for this local sidecar workload.

The dependency is therefore justified by workload shape, not by novelty.
