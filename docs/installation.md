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

Use the automated installer for normal setup:

```bash
npx --yes @xdarkicex/openclaw-memory-libravdb --yes
```

From a source checkout:

```bash
bash scripts/auto-install.sh --yes
```

The installer:

- installs or starts `libravdbd`
- falls back from Homebrew to published daemon assets on macOS when Homebrew fails
- provisions ONNX Runtime and local model assets for installer-managed daemon installs
- installs the OpenClaw plugin package
- updates `~/.openclaw/openclaw.json`
- verifies the result with `openclaw memory status`

Operator-managed macOS path:

```bash
brew tap xDarkicex/homebrew-openclaw-libravdb-memory
brew install libravdbd
brew services start libravdbd
openclaw plugins install @xdarkicex/openclaw-memory-libravdb
```

Manual Linux foreground sketch for operators who do not use the automated installer:

```bash
mkdir -p ~/.local/bin
curl -L -o ~/.local/bin/libravdbd <published-libravdbd-binary-url>
chmod +x ~/.local/bin/libravdbd
~/.local/bin/libravdbd serve
```

The automated installer writes systemd user services and macOS LaunchAgents
directly; this repository no longer documents nonexistent service-template
downloads as a manual requirement.

Windows uses a loopback TCP endpoint by default:

```text
tcp:127.0.0.1:37421
```

This repository does not yet include a full Windows service-install walkthrough.
Use the published Windows daemon asset under your preferred process supervisor
or run `libravdbd serve` in a terminal for validation.

## Activation

Assign `libravdb-memory` to the OpenClaw memory and context-engine slots:

```json
{
  "plugins": {
    "slots": {
      "memory": "libravdb-memory",
      "contextEngine": "libravdb-memory"
    },
    "entries": {
      "libravdb-memory": {
        "enabled": true,
        "config": {
          "sidecarPath": "auto"
        }
      }
    }
  }
}
```

The plugin registers both memory and context-engine capabilities at runtime.
Both exclusive slots should point at the plugin so retrieval and context
assembly use the same LibraVDB sidecar.

If the daemon uses a non-default endpoint, add `sidecarPath`:

```json
{
  "plugins": {
    "slots": {
      "memory": "libravdb-memory",
      "contextEngine": "libravdb-memory"
    },
    "entries": {
      "libravdb-memory": {
        "enabled": true,
        "config": {
          "sidecarPath": "unix:/Users/<you>/.libravdbd/run/libravdb.sock"
        }
      }
    }
  }
}
```

When `sidecarPath` is `"auto"`, macOS/Linux endpoint resolution checks:

1. `LIBRAVDB_RPC_ENDPOINT`
2. `$HOME/.libravdbd/run/libravdb.sock`
3. `/opt/homebrew/var/libravdbd/run/libravdb.sock`
4. `/usr/local/var/libravdbd/run/libravdb.sock`
5. fallback to `$HOME/.libravdbd/run/libravdb.sock`

## Default Paths

| Platform | Default endpoint |
|---|---|
| macOS/Linux user-local | `unix:$HOME/.libravdbd/run/libravdb.sock` |
| macOS Homebrew Apple Silicon | `unix:/opt/homebrew/var/libravdbd/run/libravdb.sock` |
| Windows | `tcp:127.0.0.1:37421` |

Default data path:

```text
$HOME/.libravdbd/data_nomic-embed-text-v1_5.libravdb
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
│ Embedding profile  │ nomic-embed-text-v1.5             │
│ Message            │ ok                           │
└────────────────────┴──────────────────────────────┘
```

Interpretation:

- `Sidecar=running` means the daemon answered the health check.
- `Gate threshold=0.35` confirms the default durable-memory gate.
- `Abstractive model=ready` confirms local T5-small assets were provisioned.
  `not provisioned` is still usable because compaction falls back to the
  extractive path.

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

### Homebrew stops on Command Line Tools

On macOS, Homebrew can refuse to install even prebuilt formula assets when the
local Command Line Tools are too old. The automated installer falls back to the
published daemon binary and installer-managed launchd/model assets when the
Homebrew step fails. If you require the Homebrew-managed service specifically,
update Command Line Tools and rerun the Homebrew commands.

### Hash mismatch

Do not bypass a checksum mismatch. Delete the corrupt or stale asset and rerun
setup, or republish the release with corrected checksums.

### Default memory still appears active

Confirm that `libravdb-memory` is assigned to both `plugins.slots.memory` and
`plugins.slots.contextEngine`. Without those slot entries, OpenClaw's default
memory path or legacy context engine can continue to run in parallel.

### Lifecycle journal looks empty

The sidecar journal only records advisory lifecycle hints such as `before_reset`
and `session_end`. It is bounded by `lifecycleJournalMaxEntries`, default `500`,
and is not part of normal memory recall.
