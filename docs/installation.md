# Installation Reference

This document is the full installation reference for `@xdarkicex/openclaw-memory-libravdb`. For the short path, use the root [README.md](../README.md).

## System Requirements

| Requirement | Minimum | Recommended | Notes |
|---|---|---|---|
| Node.js | `22.0.0` | Latest LTS | Enforced in [`package.json`](../package.json) `engines.node` |
| OpenClaw | `2026.3.22` | Current stable | Pinned by [`package.json`](../package.json) `peerDependencies.openclaw`; this is the earliest local tag confirmed to expose `definePluginEntry`, `registerContextEngine`, `registerMemoryPromptSection`, and the plugin API shape this repo uses |
| Go | `1.22` | Latest stable | Required only for local daemon development, not for normal plugin install |
| Disk | about `1 GB` free for default Nomic install | `2 GB+` if provisioning optional T5 and leaving room for DB growth | See Resource Requirements below |
| RAM | about `512 MB` for embed-only runtime | `1 GB+` if optional T5 summarizer is provisioned | Based on local RSS measurements below |
| OS | macOS, Linux, Windows | Current stable releases | Unix uses a local socket; Windows uses TCP loopback |
| Architecture | `arm64`, `x64` | Match published daemon release assets | Current release matrix builds five daemon targets |

The published plugin install path is scanner-clean and connect-only. End users should not need Go to install the OpenClaw plugin itself.

## Resource Requirements

The numbers in this section are either directly measured from the current local
build on `2026-03-29` or explicitly labeled as estimates.

### Disk

Measured locally from this checkout:

- daemon binary: `7.7M`
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

Measured locally on Apple M2, `2026-03-29`, by starting the daemon and reading
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

### Fastest Path on macOS

```bash
brew tap xDarkicex/openclaw-libravdb-memory
brew install libravdbd
brew services start libravdbd
openclaw plugins install @xdarkicex/openclaw-memory-libravdb
```

This is the preferred install flow for macOS users. It gives you a managed `libravdbd` service and a scanner-clean OpenClaw plugin package.

### Plugin Package

```bash
openclaw plugins install @xdarkicex/openclaw-memory-libravdb
```

The plugin package installs as normal OpenClaw source without daemon bootstrap hooks.

## Daemon Install

Install and start `libravdbd` separately for the same user account that runs OpenClaw. The daemon owns the local DB engine and listens on a local endpoint.

Default endpoints:

- macOS/Linux: `unix:$HOME/.clawdb/run/libravdb.sock`
- Windows: `tcp:127.0.0.1:37421`

If you run the daemon on a different endpoint, set `plugins.configs.libravdb-memory.sidecarPath` in `~/.openclaw/openclaw.json`.

### Linux

Recommended layout:

```bash
mkdir -p ~/.local/bin ~/.config/systemd/user
curl -L -o ~/.local/bin/libravdbd https://github.com/xDarkicex/openclaw-memory-libravdb/releases/download/vX.Y.Z/libravdbd-linux-amd64
chmod +x ~/.local/bin/libravdbd
cp packaging/systemd/libravdbd.service ~/.config/systemd/user/libravdbd.service
systemctl --user enable --now libravdbd.service
```

Then verify:

```bash
systemctl --user status libravdbd.service
openclaw memory status
```

### Homebrew / macOS

Homebrew users should normally install from the published tap:

```bash
brew tap xDarkicex/openclaw-libravdb-memory
brew install libravdbd
brew services start libravdbd
```

The release workflow generates a publish-ready `libravdbd.rb` formula asset from [`packaging/homebrew/libravdbd.rb.tmpl`](../packaging/homebrew/libravdbd.rb.tmpl). It is designed for GitHub release assets named:

- `libravdbd-darwin-arm64`
- `libravdbd-darwin-amd64`
- `libravdbd-linux-amd64`
- `libravdbd-linux-arm64`

If your GitHub Actions configuration includes:

- repository variable `HOMEBREW_TAP_REPO`, for example `xDarkicex/homebrew-openclaw-libravdb-memory`
- repository secret `HOMEBREW_TAP_TOKEN`

then tagged releases also push the generated formula into `Formula/libravdbd.rb` in that tap repository automatically.

Example plugin config:

```json
{
  "plugins": {
    "slots": {
      "memory": "libravdb-memory",
      "contextEngine": "libravdb-memory"
    },
    "configs": {
      "libravdb-memory": {
        "sidecarPath": "unix:/Users/<you>/.clawdb/run/libravdb.sock"
      }
    }
  }
}
```

## Expected Install Shape

Expected successful plugin install shape:

```text
Installed plugin: libravdb-memory
```

## Activation

The plugin declares `kind: ["memory", "context-engine"]` and is intended to own both the `memory` and `contextEngine` slots together. Treat partial slot assignment as a misconfiguration.

Add this to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "libravdb-memory",
      "contextEngine": "libravdb-memory"
    }
  }
}
```

Notes:

- This plugin should own both `memory` and `contextEngine`. Do not assign only one of them.
- The plugin id is `libravdb-memory`. The npm package name used at install time is `@xdarkicex/openclaw-memory-libravdb`.

Without a slot entry, OpenClaw's default memory can continue to run in parallel.

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

- `Sidecar=running` means the local `libravdbd` daemon answered JSON-RPC `health`.
- `Gate threshold=0.35` confirms the default gating scalar boundary is active.
- `Abstractive model=not provisioned` is acceptable. The system degrades to extractive compaction.

## Contributor Install

For contributors working from a clone:

```bash
pnpm check
cd sidecar && env GOCACHE=/tmp/openclaw-memory-libravdb-gocache go test -race ./... && cd ..
bash scripts/build-daemon.sh
```

This produces a local daemon binary in `.daemon-bin/libravdbd` (or `.exe` on Windows) and copies any locally available model/runtime assets there for testing.

## User-Service Templates

Phase 2 packaging assets are included in-repo:

- Linux user service: [`packaging/systemd/libravdbd.service`](../packaging/systemd/libravdbd.service)
- macOS LaunchAgent: [`packaging/launchd/com.xdarkicex.libravdbd.plist`](../packaging/launchd/com.xdarkicex.libravdbd.plist)

Linux example:

```bash
mkdir -p ~/.config/systemd/user
cp packaging/systemd/libravdbd.service ~/.config/systemd/user/libravdbd.service
systemctl --user enable --now libravdbd.service
```

macOS example:

1. Copy `packaging/launchd/com.xdarkicex.libravdbd.plist`
2. Replace `__LIBRAVDBD_PATH__` and `__HOME__`
3. Save it to `~/Library/LaunchAgents/com.xdarkicex.libravdbd.plist`
4. Load it with `launchctl load ~/Library/LaunchAgents/com.xdarkicex.libravdbd.plist`

## Troubleshooting

### Daemon unavailable

Common causes:

- ONNX Runtime library missing or unpacked in the wrong place
- downloaded model file hash mismatch
- `libravdbd` not started for the current user
- plugin pointed at the wrong endpoint

Check:

```bash
openclaw memory status
```

If the daemon is down, start it and verify the configured endpoint:

```bash
brew services start libravdbd
```

Or, without Homebrew:

```bash
libravdbd serve
```

On macOS/Linux, the default endpoint is `unix:$HOME/.clawdb/run/libravdb.sock`. On Windows, the default endpoint is `tcp:127.0.0.1:37421`.

### Hash mismatch

Hash mismatch means one of:

- the daemon asset is corrupt
- the local cache is stale
- the expected checksum is wrong

Do not bypass this. Delete the asset and rerun setup, or republish the release with corrected checksums.

### Windows behavior

On Windows the daemon uses a loopback TCP endpoint instead of a Unix socket. This is expected. The plugin’s transport layer already handles the fallback.

### Published daemon requirement

The daemon must come from a published `libravdbd` binary for the current platform.
If that download or checksum verification fails, setup stops instead of falling
back to a local `go build`.
