# Performance And Tuning

This document keeps resource sizing, tuning knobs, and benchmark workflows out
of the root README.

## Resource Expectations

The numbers below are local measurements from this repository as of
`2026-03-29`, unless labeled as estimates.

### Disk

Measured local asset sizes:

- daemon binary: `7.7M`
- bundled Nomic model directory: `523M`
- bundled BGE fallback model directory: about `128M`
- optional T5 summarizer directory: `371M`
- unpacked ONNX Runtime directory on macOS arm64: `44M`
- ONNX Runtime archive download on macOS arm64: `9.5M`

Vector payload lower bounds:

- BGE `384d`: `384 * 4 = 1536 bytes` per vector
- Nomic `768d`: `768 * 4 = 3072 bytes` per vector

Estimated lower-bound vector payload for `10,000` stored turns:

- BGE: about `15.4 MB`
- Nomic: about `30.7 MB`

Actual on-disk LibraVDB usage is higher because text, metadata, collection
structure, and index state are stored as well.

### Memory

Measured on Apple M2 by starting the daemon and reading RSS after startup:

- Nomic embedding path loaded without optional T5 summarizer: about `266 MB`
- Nomic plus local ONNX T5 summarizer loaded: about `503 MB`

Not yet bench-measured in this repo:

- RSS during active inference
- peak RSS during compaction of large clusters

### CPU

Measured from the current Go benchmark harness on Apple M2:

- BGE fallback query embedding: not yet bench-measured in this repo
- Nomic onnx-local query embedding: about `43.7 ms/op`

Measured from a one-off 40-query timing sample on Apple M2:

- Nomic query embedding `p50`: about `18.61 ms`
- Nomic query embedding `p95`: about `24.19 ms`

Measured from a one-off synthetic 50-turn compaction run with the current
extractive summarizer and Nomic embeddings:

- `50`-turn extractive compaction wall time: about `3175 ms`

Not yet bench-measured:

- equivalent Linux x64 embedding latency on a reference machine
- `50`-turn compaction wall time through the optional ONNX T5 abstractive path

## Runtime Tuning Fields

Prefer the defaults unless you are measuring a specific problem. These fields
are advanced controls, not required install settings.

| Field | Effect |
|---|---|
| `topK` | Search result budget before prompt fitting. |
| `alpha`, `beta`, `gamma` | Hybrid scoring weights for similarity, scope, and recency-style signals. |
| `ingestionGateThreshold` | Durable-memory promotion threshold, default `0.35`. |
| `gatingWeights` | Domain-adaptive admission weights for conversational and technical memory. |
| `gatingTechNorm` | Normalization control for the technical-content gate. |
| `gatingCentroidK` | Number of centroid candidates used by the gate. |
| `compactionQualityWeight` | How much summary confidence affects retrieval score, default `0.5`. |
| `recencyLambdaSession` | Session-memory recency decay. |
| `recencyLambdaUser` | Durable user-memory recency decay. |
| `recencyLambdaGlobal` | Global-memory recency decay. |
| `tokenBudgetFraction` | Fraction of host context budget available to memory assembly. |
| `compactThreshold` | Explicit compaction trigger threshold. |
| `compactionThresholdFraction` | Dynamic trigger ratio when `compactThreshold` is unset, default `0.8`. |
| `compactSessionTokenBudget` | Auto-compaction budget since the last compaction, default `2000`; set `0` to disable. |
| `rpcTimeoutMs` | Sidecar RPC timeout, default `30000`. |
| `maxRetries` | Retry budget for sidecar RPC calls. |
| `logLevel` | Plugin log level. |

Model-related fields live in [Embedding profiles](./embedding-profiles.md) and
[Models](./models.md).

## LongMemEval Harness

The repository includes a local LongMemEval harness that runs the dataset
through the plugin layer and checks whether the assembled prompt still contains
the evidence turns.

The benchmark runner is committed, but the dataset and generated reports are
not. Keep downloaded data and local outputs under `benchmarks/longmemeval/`,
which is ignored by default.

Run it with:

```bash
LONGMEMEVAL_DATA_FILE=/path/to/longmemeval_oracle.json pnpm run benchmark:longmemeval
```

If you already have a daemon running and do not want the benchmark to spawn
another one, set:

```bash
LONGMEMEVAL_USE_EXISTING_DAEMON=1 \
LONGMEMEVAL_SIDECAR_PATH=unix:/path/to/libravdb.sock \
pnpm run benchmark:longmemeval
```

Optional controls:

- `LONGMEMEVAL_LIMIT` caps the number of questions
- `LONGMEMEVAL_TOPK` changes the search budget
- `LONGMEMEVAL_OUT_FILE` writes JSONL records for analysis

The harness writes JSONL incrementally, so partial results survive if a
transient daemon failure interrupts a long run. If the local test daemon drops
mid-run, the benchmark restarts it and retries the current instance once before
recording an error result.

To score a hypothesis JSONL file with the official LongMemEval evaluator:

```bash
LONGMEMEVAL_EVAL_REPO=/path/to/LongMemEval \
LONGMEMEVAL_HYPOTHESIS_FILE=/path/to/hypotheses.jsonl \
LONGMEMEVAL_DATA_FILE=/path/to/longmemeval_oracle.json \
OPENAI_API_KEY=... \
pnpm run benchmark:longmemeval:score
```

The scorer wrapper shells out to the official Python evaluation script and then
prints aggregate metrics from the generated log when available.
