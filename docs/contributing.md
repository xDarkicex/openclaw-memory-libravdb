# Contributing

## Prerequisites

- Node.js `>= 22`
- Go `>= 1.22` for daemon development and release builds
- `pnpm`
- OpenClaw CLI for end-to-end plugin testing

## Core Validation Commands

TypeScript and unit checks:

```bash
pnpm check
```

Integration tests:

```bash
npm run test:integration
```

Go daemon tests:

```bash
cd sidecar
env GOCACHE=/tmp/openclaw-memory-libravdb-gocache go test ./...
env GOCACHE=/tmp/openclaw-memory-libravdb-gocache go test -race ./...
```

## Local Daemon Build

```bash
bash scripts/build-daemon.sh
```

This creates `.daemon-bin/libravdbd` and copies locally available bundled assets into `.daemon-bin/`.
That includes the embedding models, ONNX Runtime, and the bundled T5 summarizer assets when they are present under `.models/`.

## Gating Invariants

Do not weaken the gate invariants casually. The tests in `sidecar/compact/gate_test.go` check structural properties:

- empty-memory novelty
- saturation veto
- convex boundedness
- conversational collapse at `T = 0`
- technical collapse at `T = 1`
- non-overfiring conversational structure on code

If you add a new signal, it must preserve those invariants.

## Calibration Coverage

There is not yet a dedicated `gate_calibration_test.go` golden set in the
repository. Current gating correctness is enforced by the invariant suite in
[`sidecar/compact/gate_test.go`](../sidecar/compact/gate_test.go).

If you introduce new signals or change weighting behavior, do not only update
the implementation. Add one of:

- a new invariant if the change alters a structural property of the gate
- a dedicated calibration/golden test file if the change adds new labeled
  examples or expected decompositions

Do not rewrite expectations just to make regressions disappear.

## PR Expectations

Before opening a PR:

- `pnpm check` must pass
- `go test -race ./...` from `sidecar/` must pass
- any new gating signal must come with calibration or invariant coverage
- any retrieval math change must be reflected in [mathematics-v2.md](./mathematics-v2.md)
- any gating change must be reflected in [gating.md](./gating.md)

## Release Versioning

`package.json` is the source of truth for the release version.

The release automation syncs `openclaw.plugin.json` from `package.json` during the
auto-bump/tag flow, and the publish workflow refuses to publish if the Git tag,
`package.json`, and `openclaw.plugin.json` versions do not all match.
