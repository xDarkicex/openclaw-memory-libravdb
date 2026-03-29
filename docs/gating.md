# Domain-Adaptive Gating Scalar

This document describes the ingestion gate used to decide whether a user turn should be promoted into durable `user:` memory. It is the most novel scoring component in the repository.

Implemented in:

- [`sidecar/compact/gate.go`](../sidecar/compact/gate.go)
- [`sidecar/compact/tokens.go`](../sidecar/compact/tokens.go)
- [`sidecar/compact/summarize.go`](../sidecar/compact/summarize.go) for the
  downstream abstractive-routing threshold

## 1. Why the Original Scalar Failed

The original scalar assumed conversational memory semantics:

- low novelty meant "already known"
- repetition meant "probably redundant"
- low natural-language structure meant "probably noise"

That logic breaks for technical sessions.

Repeated workflow context is often exactly what should be remembered:

- file paths
- APIs
- failure signatures
- configuration changes
- architectural decisions

In technical work, repetition can indicate persistent work context rather than low value.

## 2. The Convex Mixture

The corrected gate is:

$$
G(t) = (1 - T(t)) \cdot G_{\mathrm{conv}}(t) + T(t) \cdot G_{\mathrm{tech}}(t)
$$

where:

$$
G_{\mathrm{conv}}(t) = w_1^c H(t) + w_2^c R(t) + w_3^c D_{nl}(t)
$$

$$
G_{\mathrm{tech}}(t) = w_1^t P(t) + w_2^t A(t) + w_3^t D_{\mathrm{tech}}(t)
$$

and:

$$
T(t) \in [0,1]
$$

is the technical-density signal.

Current default weights from
[`DefaultGatingConfig()`](../sidecar/compact/gate.go):

- conversational branch: $w_1^c = 0.35$, $w_2^c = 0.40$, $w_3^c = 0.25$
- technical branch: $w_1^t = 0.40$, $w_2^t = 0.35$, $w_3^t = 0.25$

### Boundedness

If:

- $T(t) \in [0,1]$
- $G_{\mathrm{conv}}(t) \in [0,1]$
- $G_{\mathrm{tech}}(t) \in [0,1]$

then:

$$
G(t) \in [0,1]
$$

because $G$ is a convex combination of two values in $[0,1]$.

### Continuity

The gate is continuous in $T$:

$$
\frac{\partial G}{\partial T} = G_{\mathrm{tech}} - G_{\mathrm{conv}}
$$

There is no discontinuous jump at a domain boundary. A mixed technical/conversational turn interpolates smoothly between the two sub-formulas.

## 3. Domain Detection $T(t)$

Technical density is a weighted sum of technical patterns with saturation:

$$
T(t) = \min\left(\frac{\sum_i s_i \cdot \mathbf{1}[\mathrm{pattern}_i(t)]}{\theta_{\mathrm{norm}}}, 1\right)
$$

The shipped patterns include:

- code fences
- file paths
- function definitions
- shell commands
- URLs or endpoints
- stack traces
- hashes or hex identifiers

Default normalization:

$$
\theta_{\mathrm{norm}} = 1.5
$$

This means two strong technical signals are enough to saturate the branch weight.

Saturation at `1.0` is correct because the gate does not need "how technical beyond fully technical"; it only needs the branch mixture weight.

## 4. Conversational Branch

### Novelty $H(t)$

Novelty is:

$$
H(t) = 1 - \frac{1}{|K|} \sum_{k \in K} \cos(\vec{v}_t, \vec{v}_k)
$$

where $K$ is the retrieved nearest-neighbor set from durable `user:` memory.

Properties:

- empty memory gives $H=1.0$
- highly similar existing memories drive $H$ toward `0`

The implementation deliberately uses top-k mean similarity rather than centroid distance because user memory is often multimodal.

### Repetition Gate $R(t)$

The repetition term is:

$$
R(t) = F(t) \cdot (1 - S(t))
$$

with:

$$
F(t) = \min\left(\frac{\mathrm{hitsAbove}(\mathrm{turns:userId}, 0.80, k=10)}{5}, 1\right)
$$

$$
S(t) = \min\left(\frac{\mathrm{hitsAbove}(\mathrm{user:userId}, 0.85, k=5)}{3}, 1\right)
$$

This is intentionally a product, not a sum.

Why:

- high input frequency should help only if durable memory is not already saturated
- high saturation should veto the repetition term regardless of frequency

The veto property is structural:

$$
S(t) = 1 \Rightarrow R(t) = 0
$$

### Natural-Language Structural Load $D_{nl}(t)$

The conversational branch adds heuristic structure for turns that look like:

- preferences
- human-name references
- dates
- quantities
- fact assertions

This is intentionally narrow. It excludes general proper-noun detection so technical identifiers do not inflate the conversational signal.

## 5. Technical Branch

### Specificity $P(t)$

Specificity measures concrete artifact density:

$$
P(t) = \min\left(
\frac{
\sum_j p_j \cdot \mathrm{count}_j(t)
}{
\max(\mathrm{EstimateTokens}(t)/100, 1)
},
1
\right)
$$

The numerator counts things like:

- file paths
- function references
- error codes
- git references
- API endpoints

The normalization denominator is implemented in
[`sidecar/compact/tokens.go`](../sidecar/compact/tokens.go):

$$
L(t)=\max\left(\left\lfloor \frac{\mathrm{len}(t)}{4} \right\rfloor, 1\right)
$$

This bytes-per-token heuristic is the token estimator used by the gating
subsystem. It is intentionally cheap and deterministic. It is not the same as
the separate host-side prompt-budget estimator in [`src/tokens.ts`](../src/tokens.ts).

Length normalization matters. Without it, any long technical turn would score
high simply because it contains more surface area, not because it is more
memory-worthy.

### Actionability $A(t)$

Actionability captures decision and outcome content:

- architectural decisions
- fixes or resolutions
- deployment or merge milestones
- configuration changes

These are the kinds of technical turns that are expensive to reconstruct later and therefore worth persisting.

### Technical Structural Load $D_{\mathrm{tech}}(t)$

This branch detects structural technical content such as:

- function definitions
- data structures
- dependencies
- tests
- documentation comments

It is the technical analogue to $D_{nl}$, not a replacement for it.

## 6. Calibration

Stored metadata includes:

- `gating_score`
- `gating_t`
- `gating_h`
- `gating_r`
- `gating_d`
- `gating_p`
- `gating_a`
- `gating_dtech`
- `gating_gconv`
- `gating_gtech`

The first calibration pass should inspect the empirical score distribution after real traffic arrives.

What to look for:

- bimodality in `gating_score`
- sensible spread in `gating_t`
- non-degenerate contributions from both `gconv` and `gtech`

For threshold tuning, isotonic regression is the correct calibration method once usefulness labels exist:

$$
P(\mathrm{useful} \mid G) = \mathrm{IsotonicRegression}(G, y)
$$

It preserves the monotonic design of the gate without assuming a sigmoid link function.

Current thresholds implemented in code:

- durable promotion threshold:
  [`DefaultGatingConfig().Threshold = 0.35`](../sidecar/compact/gate.go)
- abstractive compaction routing threshold:
  [`AbstractiveRoutingThreshold = 0.60`](../sidecar/compact/summarize.go)

## 7. Invariants

The gate has six mathematical invariants in `gate_test.go`.

### 1. Empty memory implies full novelty

$$
\mathrm{memHits} = \emptyset \Rightarrow H = 1.0
$$

This prevents a cold start from suppressing every first durable insertion.

### 2. Saturation vetoes repetition

$$
\mathrm{MemSaturation} = 1 \Rightarrow R = 0
$$

This is what makes the repetition term a true gate instead of an accumulation bonus.

### 3. The convex blend stays in bounds

$$
G \in [0,1]
$$

and:

$$
G \in [\min(G_{\mathrm{conv}}, G_{\mathrm{tech}}), \max(G_{\mathrm{conv}}, G_{\mathrm{tech}})]
$$

### 4. Purely conversational turns collapse to the conversational branch

$$
T = 0 \Rightarrow G = G_{\mathrm{conv}}
$$

### 5. Purely technical turns collapse to the technical branch

$$
T = 1 \Rightarrow G = G_{\mathrm{tech}}
$$

### 6. Conversational structure should not overfire on pure code

This guards against a common failure mode where technical identifiers masquerade as conversational entities.

Together these invariants make the scalar interpretable, stable, and safe to tune later from real traffic rather than intuition.
