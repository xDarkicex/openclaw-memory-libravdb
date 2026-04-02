# Compaction Evaluation

This document records the first local evaluation pass for the Nomic-first
compaction confidence design.

The goal of the experiment was to compare:

- raw ONNX T5 decoder confidence
- Nomic-space preservation metrics
- the planned hybrid confidence model with a hard preservation gate

The evaluation harness lives in:

- `sidecar/cmd/eval_compaction`

It runs real local models:

- Nomic `nomic-embed-text-v1.5` for embedding-space evaluation
- ONNX T5-small for optional abstractive summarization

## Why This Exists

The compaction system previously trusted T5 decoder confidence alone:

```text
conf_t5(s, C) = exp(mean log p(token_i | token_<i, C))
```

That quantity measures decoder self-consistency, not semantic preservation in
the retrieval geometry used by the vector store.

The new design evaluates every summary back in Nomic space:

```text
Q_align(s, C) = cos(E(s), mu_C)
Q_cover(s, C) = mean_i max(0, cos(E(s), E(t_i)))
conf_nomic(s, C) = clamp01((Q_align + Q_cover) / 2)
```

And then applies:

```text
if Q_align < tau_preserve:
  reject abstractive summary and fall back to extractive

confidence =
  conf_nomic                                  for extractive
  lambda * conf_nomic + (1 - lambda) * conf_t5 for T5 summaries
```

with the current implementation constants:

- `tau_preserve = 0.65`
- `lambda = 0.8`

## Baseline Corpus

The current real-model pass uses 17 fixed synthetic clusters:

- 5 normal engineering-memory clusters
- 12 adversarial clusters designed to stress abstractive faithfulness

The adversarial set included:

- conflicting subsystem failures
- dense Go code and test logic
- four-way architectural decision bundles
- many-number and threshold-heavy cases
- continuity vs progress tension
- cross-domain product/math/infra mixtures
- token-budget contract distinctions
- conflicting proposed resolutions vs the actual root cause
- long noisy code-trace clusters with one decisive invariant
- topic-shift clusters that tempt generic summaries
- near-duplicate threshold statements from different subsystems

## Results

### Core Cases

| case | raw_conf | align | cover | final_conf | delta_conf |
|---|---:|---:|---:|---:|---:|
| auth_migration | 0.8501 | 0.9183 | 0.8342 | 0.8710 | +0.0209 |
| compaction_boundary | 0.6894 | 0.7983 | 0.7216 | 0.7458 | +0.0564 |
| gating_math | 0.7790 | 0.9167 | 0.8285 | 0.8539 | +0.0748 |
| release_pipeline | 0.8859 | 0.9697 | 0.8729 | 0.9142 | +0.0283 |
| adversarial_multi_fact | 0.8545 | 0.9052 | 0.7893 | 0.8487 | -0.0058 |

### Adversarial Cases

| case | raw_conf | align | cover | final_conf | delta_conf |
|---|---:|---:|---:|---:|---:|
| adversarial_conflicting_errors | 0.8540 | 0.8579 | 0.7440 | 0.8116 | -0.0424 |
| adversarial_dense_go_code | 0.8945 | 0.9167 | 0.8212 | 0.8741 | -0.0205 |
| adversarial_four_way_decision_bundle | 0.8451 | 0.8651 | 0.7598 | 0.8190 | -0.0261 |
| adversarial_many_numbers | 0.6915 | 0.8854 | 0.7900 | 0.8084 | +0.1170 |
| adversarial_boundary_vs_progress | 0.7824 | 0.8993 | 0.8109 | 0.8406 | +0.0581 |
| adversarial_cross_domain_mix | 0.5240 | 0.8099 | 0.7327 | 0.7218 | +0.1978 |
| adversarial_token_budget_rules | 0.7938 | 0.9060 | 0.8249 | 0.8511 | +0.0573 |
| adversarial_conflicting_resolutions | 0.8600 | 0.9284 | 0.8560 | 0.8858 | +0.0258 |
| adversarial_long_noisy_code_trace | 0.8144 | 0.8565 | 0.7893 | 0.8212 | +0.0068 |
| adversarial_topic_shift_generic_bait | 0.8860 | 0.9166 | 0.8209 | 0.8722 | -0.0138 |
| adversarial_near_duplicate_thresholds | 0.8731 | 0.9123 | 0.8266 | 0.8702 | -0.0029 |

## What We Learned

### 1. T5 and Nomic are locally compatible

Every evaluated case produced:

```text
Q_align > 0.65
```

So the hard preservation gate did not trigger on the initial corpus. This is
useful evidence that the local T5 summaries are generally pointing in the same
semantic direction as the source cluster in Nomic space.

### 2. The new math improves confidence grounding

The hybrid model changed confidence more often than it changed summary text.

This is still a meaningful result:

- positive deltas mean Nomic-space preservation validated summaries that T5
  scored pessimistically
- negative deltas mean Nomic-space preservation penalized summaries that T5
  scored too generously

The largest rescue was:

- `adversarial_cross_domain_mix`: `0.5240 -> 0.7218` (`+0.1978`)

The largest penalty was:

- `adversarial_conflicting_errors`: `0.8540 -> 0.8116` (`-0.0424`)

So even without fallback, the confidence signal is more retrieval-aware than the
old T5-only design.

### 3. Harsher corpus plus threshold sweep sharpened the evidence

Even after expanding the corpus to 17 cases, the shipped gate still did not
trip:

```text
tau_preserve = 0.65  -> 0 trips
tau_preserve = 0.75  -> 0 trips
tau_preserve = 0.85  -> 2 trips
```

The two cases that fall below `0.85` are:

- `compaction_boundary`
- `adversarial_cross_domain_mix`

So the section-5 preservation machinery is now evidenced in two ways:

- unit tests prove the hard fallback path when `Q_align < tau_preserve`
- real-model threshold sweeps show where the current corpus begins to stress
  geometric drift, even though the shipped `0.65` threshold remains conservative

This means the earlier evidence gap has narrowed: the corpus is now harsh enough
to differentiate thresholds and expose weaker cases, even if it still does not
force fallback at the default gate.

Remaining interpretation questions are now about calibration, not about whether
the gate machinery exists or whether the evaluation corpus can separate stronger
and weaker summaries.

## Current Interpretation

The preservation gate is not decorative, but its first practical value is
confidence correction rather than frequent fallback.

That is still a win:

- T5 remains the lightweight local decoder
- Nomic remains the canonical retrieval geometry
- compaction confidence is now judged in the same space retrieval uses

This is the mathematically coherent compromise for a stable shippable plugin.
