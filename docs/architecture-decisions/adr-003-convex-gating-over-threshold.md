# ADR-003: Convex Gating Over Per-Domain Thresholds

## Context

A single conversational gating scalar suppressed useful technical workflow memory because conversational redundancy and technical redundancy mean different things.

## Decision

Use a convex mixture:

$$
G(t) = (1 - T(t))G_{\mathrm{conv}}(t) + T(t)G_{\mathrm{tech}}(t)
$$

instead of per-domain thresholds or user classification flags.

## Alternatives Considered

- separate thresholds for technical vs conversational users
- explicit user-level mode flags
- a larger conversational heuristic rule set

## Consequences

- one threshold instead of multiple user modes
- continuous behavior on mixed content
- greater observability through decomposed signals
