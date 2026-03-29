# Installation Reference

This document is the full installation reference for `@xdarkicex/openclaw-memory-libravdb`. For the short path, use the root [README.md](/Users/z3robit/Development/golang/src/github.com/xDarkicex/openclaw-memory-libravdb/README.md).

## System Requirements

| Requirement | Minimum | Recommended | Notes |
|---|---|---|---|
| Node.js | `22.0.0` | Latest LTS | Enforced in [`package.json`](../package.json) `engines.node` |
| OpenClaw | `2026.3.22` | Current stable | Pinned by [`package.json`](../package.json) `peerDependencies.openclaw`; this is the earliest local tag confirmed to expose `definePluginEntry`, `registerContextEngine`, `registerMemoryPromptSection`, and the plugin API shape this repo uses |
| Go | `1.22` | Latest stable | Dev/fallback build only; not required when prebuilt release assets exist |
| Disk | about `1 GB` free for default Nomic install | `2 GB+` if provisioning optional T5 and leaving room for DB growth | See Resource Requirements below |
| RAM | about `512 MB` for embed-only runtime | `1 GB+` if optional T5 summarizer is provisioned | Based on local RSS measurements below |
| OS | macOS, Linux, Windows | Current stable releases | Windows uses TCP loopback instead of Unix sockets |
| Architecture | `arm64`, `x64` | Match published release assets | Current release matrix builds five sidecar targets |

The published install path is prebuilt-first. End users should not normally need Go.

## Resource Requirements

The numbers in this section are either directly measured from the current local
build on `2026-03-29` or explicitly labeled as estimates.

### Disk

Measured locally from this checkout:

- sidecar binary: `7.7M`
- bundled Nomic model directory: `523M`
- bundled MiniLM fallback model directory: `87M`
- optional T5 summarizer directory: `371M`
- unpacked ONNX Runtime directory on macOS arm64: `44M`
- ONNX Runtime archive download on macOS arm64: `9.5M`

Practical footprints:

- default quality-first install without optional T5:
  about `575 MB` (`7.7M + 523M + 44M`)
- install with optional T5 summarizer:
  about `946 MB`

Vector payload lower bounds for stored turns, derived from embedding dimension:

- MiniLM `384d`: `384 * 4 = 1536 bytes` per vector
- Nomic `768d`: `768 * 4 = 3072 bytes` per vector

Estimated lower-bound vector payload for `10,000` stored turns:

- MiniLM: about `15.4 MB`
- Nomic: about `30.7 MB`

These are lower bounds for vector payload only. Actual on-disk LibraVDB usage is
higher because text, metadata, collection structure, and index state are stored
as well.

### Memory

Measured locally on Apple M2, `2026-03-29`, by starting the sidecar and reading
RSS after startup:

- idle RSS with Nomic embedding path loaded and no optional T5 summarizer:
  about `271,872 KB` (`~266 MB`)
- idle RSS with Nomic plus local ONNX T5 summarizer loaded:
  about `515,312 KB` (`~503 MB`)

Not yet bench-measured in the repo:

- RSS during active inference
- peak RSS during compaction of large clusters

Current operational estimate:

- embedding inference should remain close to the embed-only idle baseline plus
  transient ONNX workspace allocation
- optional T5 provisioning roughly doubles steady-state RSS

### CPU

Measured locally from the existing Go benchmark harness on Apple M2,
`2026-03-29`:

- MiniLM bundled query embedding: about `22.6 ms/op`
- MiniLM onnx-local query embedding: about `16.3 ms/op`
- Nomic onnx-local query embedding: about `43.7 ms/op`

Measured locally from a one-off 40-query timing sample on Apple M2,
`2026-03-29`:

- Nomic query embedding `p50`: about `18.61 ms`
- Nomic query embedding `p95`: about `24.19 ms`

Measured locally from a one-off synthetic 50-turn compaction run using the
current extractive summarizer and Nomic embeddings:

- `50`-turn extractive compaction wall time: about `3175 ms`

Not yet bench-measured in the repo:

- equivalent Linux x64 embedding latency on a reference machine
- `50`-turn compaction wall time through the optional ONNX T5 abstractive path

### Network

Setup downloads are front-loaded. After installation, the plugin is local-first.

Current setup assets:

- Nomic model: about `522 MB`
- T5-small encoder: about `135 MB`
- T5-small decoder: about `222 MB`
- ONNX Runtime macOS arm64 archive: about `9.5 MB`

After install, the plugin makes no required network calls for embedding or
extractive compaction. The only optional runtime network path is:

- `summarizerBackend = "ollama-local"` or another custom summarizer endpoint

## Standard Install

```bash
openclaw plugins install @xdarkicex/openclaw-memory-libravdb
```

Expected successful install shape on a published release:

```text
[openclaw-memory-libravdb] Sidecar installed (prebuilt clawdb-sidecar-<platform>)
[openclaw-memory-libravdb] Provisioning embedding model...
[openclaw-memory-libravdb] Provisioning ONNX runtime...
[openclaw-memory-libravdb] Provisioning summarizer model... (optional)
[openclaw-memory-libravdb] Verifying sidecar health...
[openclaw-memory-libravdb] Setup complete.
Installed plugin: libravdb-memory
```

If the host also activates the plugin into the exclusive memory slot during the
same flow, output should additionally include a line like:

```text
Exclusive slot "memory" switched from "memory-core" to "libravdb-memory".
```

That slot-takeover line is the proof that OpenClaw is no longer using the stock
memory provider.

Development fallback shape when a prebuilt sidecar asset is not available:

```text
[openclaw-memory-libravdb] Prebuilt binary unavailable. Attempting local go build...
[openclaw-memory-libravdb] This requires Go >= 1.22: https://go.dev/dl/
[openclaw-memory-libravdb] Sidecar installed (local build)
...
```

Published users should rarely see the fallback path. If they do, the plugin
version likely has not published sidecar release assets for that platform yet.

## Activation

The plugin declares `kind: "memory"` and is intended to occupy the `memory` slot. If your OpenClaw build also exposes legacy context-engine slotting, keep the memory slot authoritative and use the context-engine slot only for compatibility testing.

Add this to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "libravdb-memory",
      "contextEngine": "legacy"
    }
  }
}
```

Notes:

- `memory: "libravdb-memory"` is the actual activation step.
- `contextEngine: "legacy"` keeps the legacy engine explicit when the host still exposes that slot.
- If you instead point `contextEngine` at another plugin, you are changing a separate slot from the memory replacement.
- The plugin id is `libravdb-memory`. The npm package name used at install time is `@xdarkicex/openclaw-memory-libravdb`.

Without the `memory` slot entry, OpenClaw's default memory can continue to run in parallel.

## Verification

Run:

```bash
openclaw memory status
```

Expected output shape:

```text
┌────────────────────┬──────────────────────────────┐
│ Sidecar            │ running                      │
│ Turns stored       │ 0                            │
│ Memories stored    │ 0                            │
│ Gate threshold     │ 0.35                         │
│ Abstractive model  │ ready | not provisioned      │
│ Embedding profile  │ nomic-embed-text-v1.5        │
│ Message            │ ok                           │
└────────────────────┴──────────────────────────────┘
```

Interpretation:

- `Sidecar=running` means the Go sidecar booted and answered JSON-RPC `health`.
- `Gate threshold=0.35` confirms the default gating scalar boundary is active.
- `Abstractive model=not provisioned` is acceptable. The system degrades to extractive compaction.

## Contributor Install

For contributors working from a clone:

```bash
pnpm check
cd sidecar && env GOCACHE=/tmp/openclaw-memory-libravdb-gocache go test -race ./... && cd ..
node scripts/setup.ts
```

Optional direct dev build:

```bash
bash scripts/build-sidecar.sh
```

This produces a local sidecar in `.sidecar-bin/` and copies any locally available model/runtime assets there for testing.

## Troubleshooting

### Sidecar fails to start

Common causes:

- ONNX Runtime library missing or unpacked in the wrong place
- downloaded model file hash mismatch
- local Go fallback unavailable and no prebuilt asset for the requested version

Check:

```bash
openclaw memory status
```

If the sidecar is down, rerun:

```bash
node scripts/setup.ts
```

### Model download fails

The setup script verifies hashes for required assets. A failed or partial download is deleted and retried on the next run. This is intentional. A model file that exists but fails hash verification is treated as corrupt.

### Hash mismatch

Hash mismatch means one of:

- the release asset is corrupt
- the local cache is stale
- the expected checksum is wrong

Do not bypass this. Delete the asset and rerun setup, or republish the release with corrected checksums.

### Windows behavior

On Windows the sidecar advertises a loopback TCP endpoint instead of a Unix socket. This is expected. The plugin’s transport layer already handles the fallback.

### Local fallback path

If the installer logs that it is attempting a local `go build`, the prebuilt release asset was not available for the plugin version being installed. For published tags this should be unusual; for branch or unreleased work it is expected.
