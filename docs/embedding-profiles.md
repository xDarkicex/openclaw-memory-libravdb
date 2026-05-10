# Embedding Profiles

The plugin uses `embeddingProfile` for named local model metadata defaults.

Default selection baseline:

- default embedding profile: `nomic-embed-text-v1.5`
- bundled fallback profile: `bge-small-en-v1.5`

Why:

- Nomic is the default because its Matryoshka-trained embeddings deliver significantly higher retrieval accuracy than MiniLM, with principled dimensionality tiering (`64d → 256d → 768d`) that lets the daemon trade memory for precision without re-embedding.
- bge-small-en-v1.5 is the fallback for resource-constrained systems and is automatically selected when the primary model's dimensions do not match the active collection.
- Intel Macs without reliable Metal/MPS support should set `onnxDevice: "cpu"` to force CPU ONNX execution and bypass CoreML.

Current shipped profile names:

- `nomic-embed-text-v1.5`
  - family: `nomic-embed-text-v1.5`
  - dimensions: `768`
  - normalize: `true`
  - max context tokens: `8192`

- `bge-small-en-v1.5`
  - family: `bge-small-en-v1.5`
  - dimensions: `384`
  - normalize: `true`
  - max context tokens: `512`

How it works:

- `embeddingProfile` supplies metadata defaults like family, dimensions, and normalize behavior.
- `onnx-local` still requires local model assets through `embeddingModelPath`, typically a directory containing `embedding.json`.
- The manifest may override or refine the profile, but explicit dimension mismatches fail closed.
- The sidecar store persists an embedding fingerprint, so reopening an existing store with a different effective model profile will fail instead of silently mixing vector spaces.
- `onnxDevice` is passed through as `LIBRAVDB_ONNX_DEVICE` for daemon versions that support execution-provider selection (`auto`, `cpu`, `cuda`, `coreml`, `directml`, `openvino`).

Recommended usage:

- `bundled` for the shipped default path, which uses `nomic-embed-text-v1.5`.
- `onnx-local` plus `embeddingProfile` when a power user wants a known model family with local assets.
- treat remote/Ollama providers as future separate backend types, not as overloads of `custom-local`.
