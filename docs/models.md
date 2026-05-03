# Model Strategy

The plugin uses local ONNX-first inference for embeddings and optional
abstractive summarization. That keeps prompt assembly local, predictable, and
available offline after assets are installed.

## Why ONNX Over Ollama For The Critical Path

`assemble` runs before each response build. An embedding request that crosses a
process and HTTP server boundary adds avoidable tail latency. Local ONNX
inference inside the sidecar keeps retrieval close to the database and avoids a
runtime dependency on a separate model server.

ONNX assets can be provisioned once and reused without network access. Given
fixed weights and input, embeddings are deterministic enough for stable
similarity ordering and reproducible retrieval behavior.

The trade-off is artifact size. This project accepts that cost because local
latency and offline operation are part of the product contract.

## Default And Optional Embedding Profiles

The current safe default profile is `nomic-embed-text-v1.5`.

MiniLM is the default because it keeps local retrieval within the target memory
envelope on macOS and is less fragile with ONNX Runtime execution than larger
profiles.

`nomic-embed-text-v1.5` remains available as an explicit opt-in profile for
long-context retrieval experiments. Nomic's Matryoshka training makes
`64d -> 256d -> 768d` tiering principled rather than arbitrary truncation, but
its larger footprint makes it a less conservative default.

For exact profile metadata, read [Embedding profiles](./embedding-profiles.md).

## Summarization

Compaction can run without an abstractive summarizer. When the optional T5-small
assets are not provisioned, the daemon degrades to the extractive path.

T5-small is the optional local abstractive summarizer because it is small enough
for CPU-local operation while still useful for session-cluster summaries. Larger
generative models would increase latency and operational complexity.

## Model Roles

| Model/profile | Role |
|---|---|
| `nomic-embed-text-v1.5` | Default lightweight embedding profile. |
| `nomic-embed-text-v1.5` | Opt-in long-context embedding profile. |
| T5-small | Optional local abstractive compaction summarizer. |

External summarizer endpoints, such as Ollama, are optional. They are not part
of the required retrieval path.
