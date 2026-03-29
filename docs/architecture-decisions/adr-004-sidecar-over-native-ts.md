# ADR-004: Sidecar Over Native TypeScript

## Context

The plugin requires local vector storage, ONNX inference, transport isolation, and bounded failure semantics that should not crash the host chat session.

## Decision

Implement the memory engine as a Go sidecar with a narrow JSON-RPC transport boundary.

## Alternatives Considered

- native TypeScript implementation
- WASM-only embedding and storage path

## Consequences

- strong process isolation
- efficient local inference and storage integration
- extra packaging complexity
- a separate binary distribution story
