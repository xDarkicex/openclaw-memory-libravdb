# ADR-002: LibraVDB Over LanceDB

## Context

The plugin needs multi-scope namespacing, delete-heavy compaction flows, and local-first operation without a Python dependency chain.

## Decision

Use LibraVDB as the vector store.

## Alternatives Considered

- LanceDB

## Consequences

- better fit for collection-scoped lifecycle management
- more control over local operational behavior
- deeper ownership of vector store behavior and tuning
