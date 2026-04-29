# Embedding Profiles

The plugin now supports a lightweight `embeddingProfile` setting for named local model metadata defaults.

Default selection baseline as of `2026-03-28`:

- default embedding profile: `all-minilm-l6-v2`
- bundled fallback profile: `all-minilm-l6-v2`

Why:

- MiniLM keeps the local LongMemEval retrieval slice inside the target memory envelope on macOS.
- Nomic remains available as an explicit opt-in profile for long-context experiments.
- Nomic ONNX on macOS is fragile with CoreML execution and can trigger multi-GB RSS, so it is no longer the safe bundled default.
- Intel Macs without reliable Metal/MPS support should set `onnxDevice: "cpu"` to force CPU ONNX execution and bypass CoreML.

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
- `onnxDevice` is passed through as `LIBRAVDB_ONNX_DEVICE` for daemon versions that support execution-provider selection (`auto`, `cpu`, `cuda`, `coreml`, `directml`, `openvino`).

Recommended usage:

- `bundled` for the shipped default path, which now prefers MiniLM for local stability.
- `onnx-local` plus `embeddingProfile` when a power user wants a known model family like Nomic with local assets.
- treat remote/Ollama providers as future separate backend types, not as overloads of `custom-local`.
