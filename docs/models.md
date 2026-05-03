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

The default profile is `nomic-embed-text-v1.5`. Nomic was chosen as the default
because its Matryoshka-trained embeddings deliver significantly higher retrieval
accuracy than MiniLM, with principled dimensionality tiering (`64d → 256d →
768d`) that lets the daemon trade memory for precision without re-embedding.

`bge-small-en-v1.5` is the fallback profile. It has a smaller disk and memory
footprint than Nomic and is automatically selected when the primary model's
dimensions do not match the active collection. Operators on resource-constrained
systems can also set it as the primary profile for lighter local inference.

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
| `nomic-embed-text-v1.5` | Default embedding profile — high-accuracy Matryoshka embeddings. |
| `bge-small-en-v1.5` | Fallback embedding profile — lighter footprint for constrained systems. |
| T5-small | Optional local abstractive compaction summarizer. |

External summarizer endpoints, such as Ollama, are optional. They are not part
of the required retrieval path.
