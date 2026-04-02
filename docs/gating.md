# Domain-Adaptive Gating Scalar

This document describes the ingestion gate used to decide whether a user turn should be promoted into durable `user:` memory. It is the most novel scoring component in the repository.

Implemented in:
- `sidecar/compact/gate.go`
- `sidecar/compact/tokens.go`
- `sidecar/compact/summarize.go` for the downstream abstractive-routing threshold

## 1. Why the Original Scalar Failed

The original scalar assumed conversational memory semantics:
- low novelty meant "already known"
- repetition meant "probably redundant"
- low natural-language structure meant "probably noise"

That logic breaks for technical sessions. Repeated workflow context is often exactly what should be remembered: file paths, APIs, failure signatures, configuration changes, and architectural decisions. In technical work, repetition can indicate persistent work context rather than low value.

## 2. The Convex Mixture

The corrected gate is:
\[ G(t) = (1 - T(t)) \cdot G_{\mathrm{conv}}(t) + T(t) \cdot G_{\mathrm{tech}}(t) \]

where:
\[ G_{\mathrm{conv}}(t) = w_1^c H(t) + w_2^c R(t) + w_3^c D_{nl}(t) \]
\[ G_{\mathrm{tech}}(t) = w_1^t P(t) + w_2^t A(t) + w_3^t D_{\mathrm{tech}}(t) \]

and the domain indicator is bounded:
\[ T(t) \in [0,1] \]

### Weight Invariants
To guarantee that the sub-branch scores remain strictly bounded to $[0,1]$, the configuration must satisfy:
\[ \sum_{i=1}^3 w_i^c = 1 \quad \text{and} \quad \sum_{i=1}^3 w_i^t = 1 \]

Current default weights from `DefaultGatingConfig()`:
- conversational branch: $w_1^c = 0.35$, $w_2^c = 0.40$, $w_3^c = 0.25$
- technical branch: $w_1^t = 0.40$, $w_2^t = 0.35$, $w_3^t = 0.25$

### Boundedness and Continuity
Because $T(t) \in [0,1]$, $G_{\mathrm{conv}}(t) \in [0,1]$, and $G_{\mathrm{tech}}(t) \in [0,1]$, $G(t)$ is a true convex combination bounded to $[0,1]$.

The gate is continuous in $T$:
\[ \frac{\partial G}{\partial T} = G_{\mathrm{tech}} - G_{\mathrm{conv}} \]
There is no discontinuous jump at a domain boundary. A mixed technical/conversational turn interpolates smoothly.

## 3. Domain Detection $T(t)$

Technical density is a weighted sum of technical patterns with saturation:
\[ T(t) = \min\left(\frac{\sum_i s_i \cdot \mathbf{1}[\mathrm{pattern}_i(t)]}{\theta_{\mathrm{norm}}}, 1\right) \]

The shipped patterns include code fences, file paths, function definitions, shell commands, URLs, stack traces, and hashes.

Default normalization is $\theta_{\mathrm{norm}} = 1.5$. This means two strong technical signals are enough to saturate the branch weight. Saturation at `1.0` is correct because the gate only needs the branch mixture weight, not a unbounded "technical magnitude."

## 4. Conversational Branch

### Novelty $H(t)$

In the live implementation (`sidecar/compact/gate.go`), retrieval scores reaching the gate use the public higher-is-better cosine-style relevance contract from the retrieval layer, spanning $[-1, 1]$ for cosine collections. To ensure the novelty term remains in $[0,1]$ for the convex mixture, the mathematical model applies a zero-clamp:

\[ H(t) = \begin{cases} 
1.0 & \text{if } |K| = 0 \\ 
1 - \frac{1}{|K|} \sum_{k \in K} \max(0, \cos(\vec{v}_t, \vec{v}_k)) & \text{otherwise}
\end{cases} \]

where $K$ is the retrieved nearest-neighbor set from durable `user:` memory.

Properties:
- An empty memory (cold start) safely returns $H=1.0$ instead of a division-by-zero.
- Highly similar existing memories ($\cos \to 1$) drive $H \to 0$.
- Negative or orthogonal neighbors are clamped to prevent $H(t) > 1$.

### Repetition Gate $R(t)$

The repetition term is a product, not a sum:
\[ R(t) = F(t) \cdot (1 - S(t)) \]

with:
\[ F(t) = \min\left(\frac{\mathrm{hitsAbove}(\mathrm{turns:userId}, 0.80, k=10)}{5}, 1\right) \]
\[ S(t) = \min\left(\frac{\mathrm{hitsAbove}(\mathrm{user:userId}, 0.85, k=5)}{3}, 1\right) \]

Why a product? High input frequency should help only if durable memory is not already saturated. High saturation must veto the repetition term regardless of frequency. The veto property is structural: $S(t) = 1 \Rightarrow R(t) = 0$.

### Natural-Language Structural Load $D_{nl}(t)$
Detects heuristics like preferences, human-name references, dates, and fact assertions.

## 5. Technical Branch

### Specificity $P(t)$

Specificity measures concrete artifact density normalized by turn length:

\[ P(t) = \min\left( \frac{\sum_j p_j \cdot \mathrm{count}_j(t)}{\max(L(t)/100.0, 1.0)}, 1 \right) \]

The numerator counts things like file paths, error codes, and API endpoints.
The normalization denominator is the token estimator used by the gating subsystem (`sidecar/compact/tokens.go`):
\[ L(t) = \max\left(\left\lfloor \frac{\mathrm{RuneCount}(t)}{4} \right\rfloor, 1\right) \]

Length normalization matters. Without it, any long technical turn would score high simply because it contains more surface area, not because it is more memory-worthy.

### Actionability $A(t)$
Captures architectural decisions, fixes, merge milestones, and configuration changes.

### Technical Structural Load $D_{\mathrm{tech}}(t)$
Detects function definitions, dependencies, and tests. It is the technical analogue to $D_{nl}$.

## 6. Calibration

For threshold tuning, isotonic regression is the correct calibration method once usefulness labels exist:
\[ P(\mathrm{useful} \mid G) = \mathrm{IsotonicRegression}(G, y) \]

Current thresholds implemented in code:
- durable promotion: `DefaultGatingConfig().Threshold = 0.35`
- abstractive routing: `AbstractiveRoutingThreshold = 0.60`

## 7. Invariants

The gate preserves six mathematical invariants mapped to `gate_test.go`:

1. **Empty memory implies full novelty:** $\mathrm{memHits} = \emptyset \Rightarrow H = 1.0$
2. **Saturation vetoes repetition:** $\mathrm{MemSaturation} = 1 \Rightarrow R = 0$
3. **The convex blend stays in bounds:** $G \in [0,1]$
4. **Monotonic Interpolation:** $G \in [\min(G_{\mathrm{conv}}, G_{\mathrm{tech}}), \max(G_{\mathrm{conv}}, G_{\mathrm{tech}})]$
5. **Purely conversational turns collapse:** $T = 0 \Rightarrow G = G_{\mathrm{conv}}$
6. **Purely technical turns collapse:** $T = 1 \Rightarrow G = G_{\mathrm{tech}}$

Conversational structure must not overfire on pure code. Together these invariants make the scalar interpretable, stable, and safe to tune.
