# Dependency Rationale

## npm audit and Connect transport dependencies

The npm package depends on `@connectrpc/connect-node` for the gRPC transport used
to reach the separately installed `libravdbd` service. The current Connect 1.x
line resolves `@connectrpc/connect-node@1.7.0`, which depends on `undici@5.29.0`.

Some npm consumers may therefore see `npm audit --omit=dev` report this path:

```text
@xdarkicex/openclaw-memory-libravdb
└─┬ @connectrpc/connect-node@1.7.0
  └── undici@5.29.0
```

This is not fixed by the `pnpm.overrides` entry in this repository. That override
only affects this repo's own pnpm install; it does not force npm's dependency
resolution in a consuming OpenClaw project.

If an operator needs a temporary npm-side audit workaround while the plugin still
targets Connect 1.x, use root-project `overrides` in the consuming project:

```json
{
  "overrides": {
    "undici": "6.24.0"
  }
}
```

Then reinstall and re-run the audit:

```bash
npm install
npm audit --omit=dev
```

Treat this as a consumer workaround, not the upstream package fix. Moving the
plugin itself to Connect 2.x is a source migration, not a one-line dependency
bump: Connect 2 removes the current `createPromiseClient` API, protobuf 2 removes
the current `PartialMessage` export used by this codebase, and transport options
changed. The durable upstream fix needs the plugin and generated contracts to
migrate across that API boundary together.

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

The measured conclusion from the internal profiling pass was that slab-backed raw-vector storage was performance-competitive with the plain in-memory backend while making allocation behavior more predictable. The main trade-off is reserved-but-unused capacity, which is acceptable for this local vector service workload.

The dependency is therefore justified by workload shape, not by novelty.
