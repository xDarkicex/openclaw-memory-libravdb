# Installation Reference

This is the full installation reference for
`@xdarkicex/openclaw-memory-libravdb`. For the shortest path, use
[install.md](./install.md).

## System Requirements

| Requirement | Minimum | Notes |
|---|---:|---|
| Node.js | `22.0.0` | Enforced by `package.json` `engines.node`. |
| OpenClaw | `2026.3.22` | Earliest supported host version for this plugin API shape. |
| `libravdbd` | published daemon asset | Required for normal runtime. |
| Go | `1.22` | Required only for local daemon development. |
| OS | macOS, Linux, Windows | Unix uses a local socket; Windows uses TCP loopback. |
| Architecture | `arm64`, `x64` | Must match the daemon release asset. |

Resource sizing and benchmark data live in
[Performance and tuning](./performance-and-tuning.md).

OpenClaw compatibility note:

- the plugin is currently verified against OpenClaw `2026.4.23`

## Install Flow

The published plugin package is connect-only. It installs TypeScript plugin code
and docs; it does not compile Go code, download model assets, or supervise the
daemon.

Recommended macOS path:

```bash
brew tap xDarkicex/homebrew-openclaw-libravdb-memory
brew install libravdbd
brew services start libravdbd
openclaw plugins install @xdarkicex/openclaw-memory-libravdb
```

Manual Linux sketch:

```bash
mkdir -p ~/.local/bin ~/.config/systemd/user
curl -L -o ~/.local/bin/libravdbd <published-libravdbd-binary-url>
chmod +x ~/.local/bin/libravdbd
curl -L -o ~/.config/systemd/user/libravdbd.service <published-libravdbd-service-template-url>
systemctl --user enable --now libravdbd.service
openclaw plugins install @xdarkicex/openclaw-memory-libravdb
```

Windows uses a loopback TCP endpoint by default:

```text
tcp:127.0.0.1:37421
```

This repository does not yet include a full Windows service-install walkthrough.
Use the published Windows daemon asset under your preferred process supervisor
or run `libravdbd serve` in a terminal for validation.

## Activation

Assign `libravdb-memory` to the OpenClaw memory slot:

```json
{
  "plugins": {
    "slots": {
      "memory": "libravdb-memory"
    }
  }
}
```

The plugin registers both memory and context-engine capabilities at runtime;
current OpenClaw config only needs the `memory` slot assignment.

If the daemon uses a non-default endpoint, add `sidecarPath`:

```json
{
  "plugins": {
    "slots": {
      "memory": "libravdb-memory"
    },
    "entries": {
      "libravdb-memory": {
        "enabled": true,
        "config": {
          "sidecarPath": "unix:/Users/<you>/.clawdb/run/libravdb.sock"
        }
      }
    }
  }
}
```

When `sidecarPath` is `"auto"`, macOS/Linux endpoint resolution checks:

1. `LIBRAVDB_RPC_ENDPOINT`
2. `$HOME/.clawdb/run/libravdb.sock`
3. `/opt/homebrew/var/clawdb/run/libravdb.sock`
4. `/usr/local/var/clawdb/run/libravdb.sock`
5. fallback to `$HOME/.clawdb/run/libravdb.sock`

## Default Paths

| Platform | Default endpoint |
|---|---|
| macOS/Linux user-local | `unix:$HOME/.clawdb/run/libravdb.sock` |
| macOS Homebrew Apple Silicon | `unix:/opt/homebrew/var/clawdb/run/libravdb.sock` |
| Windows | `tcp:127.0.0.1:37421` |

Default data path:

```text
$HOME/.clawdb/data.libravdb
```

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
│ Lifecycle hints    │ 0                            │
│ Gate threshold     │ 0.35                         │
│ Abstractive model  │ ready | not provisioned      │
│ Embedding profile  │ all-minilm-l6-v2             │
│ Message            │ ok                           │
└────────────────────┴──────────────────────────────┘
```

Interpretation:

- `Sidecar=running` means the daemon answered the health check.
- `Gate threshold=0.35` confirms the default durable-memory gate.
- `Abstractive model=not provisioned` is acceptable; compaction falls back to
  the extractive path.

## Troubleshooting

### Daemon unavailable

Common causes:

- `libravdbd` is not running for the same user account as OpenClaw
- `sidecarPath` points at the wrong endpoint
- ONNX Runtime assets are missing or unpacked in the wrong place
- a model asset failed checksum validation

Check the daemon first:

```bash
openclaw memory status
brew services restart libravdbd
```

For foreground debugging:

```bash
libravdbd serve
```

### Hash mismatch

Do not bypass a checksum mismatch. Delete the corrupt or stale asset and rerun
setup, or republish the release with corrected checksums.

### Default memory still appears active

Confirm that `libravdb-memory` is assigned to `plugins.slots.memory`.
Without that slot entry, OpenClaw's default memory path can continue to run in
parallel.

### Lifecycle journal looks empty

The sidecar journal only records advisory lifecycle hints such as `before_reset`
and `session_end`. It is bounded by `lifecycleJournalMaxEntries`, default `500`,
and is not part of normal memory recall.
