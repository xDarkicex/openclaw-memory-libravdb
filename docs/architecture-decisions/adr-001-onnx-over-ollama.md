# ADR-001: ONNX Over Ollama

## Context

The plugin needs local embedding inference on the prompt-assembly critical path and optional local summarization for compaction.

## Decision

Use ONNX-first local inference for embedding and optional summarization. Treat Ollama as an optional external backend, not the primary dependency.

## Alternatives Considered

- Ollama for both embedding and summarization
- remote inference APIs

## Consequences

- predictable latency
- deterministic embeddings
- offline operation
- larger local artifact footprint
