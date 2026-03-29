# Embedding Profiles

The plugin now supports a lightweight `embeddingProfile` setting for named local model metadata defaults.

Default selection baseline as of `2026-03-28`:

- default embedding profile: `nomic-embed-text-v1.5`
- bundled fallback profile: `all-minilm-l6-v2`

Why:

- MiniLM and Nomic are equivalent on the current lexical and paraphrase baseline.
- Nomic materially outperforms MiniLM on cross-domain ranking quality.
- Nomic is the only profile that clears the long-context baseline once sliding-window document embedding is applied.
- Adversarial lexical traps remain reranker-window cases, but Nomic still narrows the relevant-vs-distractor margin materially.

Current shipped profile names:

- `all-minilm-l6-v2`
  - family: `all-minilm-l6-v2`
  - dimensions: `384`
  - normalize: `true`
  - max context tokens: `128`

- `nomic-embed-text-v1.5`
  - family: `nomic-embed-text-v1.5`
  - dimensions: `768`
  - normalize: `true`
  - max context tokens: `8192`

How it works:

- `embeddingProfile` supplies metadata defaults like family, dimensions, and normalize behavior.
- `onnx-local` still requires local model assets through `embeddingModelPath`, typically a directory containing `embedding.json`.
- The manifest may override or refine the profile, but explicit dimension mismatches fail closed.
- The sidecar store persists an embedding fingerprint, so reopening an existing store with a different effective model profile will fail instead of silently mixing vector spaces.

Recommended usage:

- `bundled` for the shipped default path, which now prefers Nomic and falls back to MiniLM if the primary profile is unavailable.
- `onnx-local` plus `embeddingProfile` when a power user wants a known model family like Nomic with local assets.
- treat remote/Ollama providers as future separate backend types, not as overloads of `custom-local`.
