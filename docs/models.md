# Model Strategy

## Why ONNX Over Ollama

The plugin uses ONNX-first local inference for embedding and optional abstractive summarization.

### Latency

`assemble` is on the critical path before every response build. An embedding request that crosses process and HTTP boundaries adds avoidable tail latency. Local ONNX inference inside the sidecar keeps the retrieval path in the low-millisecond range on the target hardware profile.
`assemble` is on the critical path before every response build. An embedding
request that crosses process and HTTP boundaries adds avoidable tail latency.
Local ONNX inference inside the sidecar keeps the retrieval path local and
predictable. On the current Apple M2 development machine, the repository's own
benchmark harness measures roughly `16-23 ms/op` for MiniLM query embeddings and
about `44 ms/op` for Nomic in the steady-state Go benchmark path.

### Offline Operation

The plugin is designed to be local-first. Requiring a running Ollama server would break that guarantee. ONNX assets can be provisioned once and reused without network or daemon availability.

### Determinism

ONNX inference is deterministic given fixed weights and input. Deterministic embeddings give stable similarity ordering and reproducible retrieval behavior.

### Binary Size Trade-Off

Local models increase the artifact footprint. That is an explicit trade-off accepted by the architecture because predictable latency and offline operation are more important for this plugin than minimal package size.

## Why `nomic-embed-text-v1.5`

This is the default embedding profile because it earned the role on two axes:

- long-context document support
- Matryoshka structure for tiered retrieval

The model’s Matryoshka training is what makes the `64d -> 256d -> 768d` cascade principled rather than arbitrary truncation.

## Why `all-minilm-l6-v2` Still Exists

MiniLM remains the lightweight fallback profile. It is useful when:

- the full Nomic profile is unavailable
- a smaller bundled footprint matters more than long-context or Matryoshka behavior

It is no longer the quality-first default.

## Why T5-small for Summarization

The abstractive summarization path is optional and must remain CPU-feasible on local machines. T5-small fits that constraint better than larger generative models:

- small enough to run locally
- expressive enough for session-cluster summarization
- does not require a remote server

The plugin still degrades gracefully to extractive compaction when the T5 assets are not provisioned.

## Model Roles in the System

- Nomic embedder: quality-first retrieval path, Matryoshka tiers
- MiniLM: fallback embedder
- T5-small: optional higher-quality compaction summarizer

The model strategy is therefore not “use ONNX everywhere because ONNX is fashionable.” It is “use ONNX where local deterministic inference is part of the product contract.”
