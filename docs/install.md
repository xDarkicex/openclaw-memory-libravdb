# Install Guide

LibraVDB Memory ships an explicit automated installer for the full local stack:
daemon, ONNX Runtime, model assets, OpenClaw plugin package, plugin activation,
and verification.

OpenClaw compatibility note:

- the plugin is currently verified against OpenClaw `2026.4.23`

For deeper operational detail, use the full
[installation reference](./installation.md).

## Recommended Path: Automated Installer

Run:

```bash
npx --yes @xdarkicex/openclaw-memory-libravdb --yes
```

This gives you:

- a running `libravdbd` service
- provisioned ONNX Runtime and local model assets for installer-managed daemon installs
- an installed OpenClaw plugin package
- `~/.openclaw/openclaw.json` updated with the current `plugins.entries` config shape
- a final `openclaw memory status` verification

From a source checkout, run the same installer script:

```bash
bash scripts/auto-install.sh --yes
```

On macOS, the installer tries Homebrew first when accepted. If Homebrew fails,
it falls back to the published daemon binary plus installer-managed launchd,
ONNX Runtime, and model assets.

## Plugin-Only Install

Install the plugin package with the OpenClaw CLI:

```bash
openclaw plugins install @xdarkicex/openclaw-memory-libravdb
```

Use this path only when an operator already manages `libravdbd` and assets.
If you use the OpenClaw.ai plugin UI instead of the CLI, install the same package
and then assign the plugin id `libravdb-memory` to both the `memory` and
`contextEngine` slots.

The current config shape is:

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

If you run the daemon on a non-default endpoint, add a plugin config:

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

When `sidecarPath` is set to `"auto"`, the plugin resolves endpoints in this order on macOS/Linux:

1. `LIBRAVDB_RPC_ENDPOINT` if it is set to a valid daemon endpoint
2. `$HOME/.libravdbd/run/libravdb.sock` if it exists
3. `/opt/homebrew/var/libravdbd/run/libravdb.sock` if it exists
4. `/usr/local/var/libravdbd/run/libravdb.sock` if it exists
5. fallback to `$HOME/.libravdbd/run/libravdb.sock`

## Sidecar Daemon Install

The daemon owns the local database, embeddings, and JSON-RPC endpoint.

Default endpoints:

- Homebrew on macOS (Apple Silicon): `unix:/opt/homebrew/var/libravdbd/run/libravdb.sock`
- Homebrew on macOS (Intel): `unix:/usr/local/var/libravdbd/run/libravdb.sock`
- macOS/Linux user-local installs: `unix:$HOME/.libravdbd/run/libravdb.sock`
- Windows: `tcp:127.0.0.1:37421`

Default data path:

- macOS/Linux user installs: `$HOME/.libravdbd/data_nomic-embed-text-v1_5.libravdb`
- Windows user installs: `%USERPROFILE%\.libravdbd\data_nomic-embed-text-v1_5.libravdb`

### Homebrew

Homebrew is the preferred daemon lifecycle on macOS:

```bash
brew tap xDarkicex/homebrew-openclaw-libravdb-memory
brew install libravdbd
brew services start libravdbd
```

Useful lifecycle commands:

```bash
brew services restart libravdbd
brew services stop libravdbd
brew info libravdbd
```

### Manual Service Management

If you are not using Homebrew, prefer the installer-managed manual service path.
It writes the launchd/systemd wiring directly instead of relying on external
service-template files:

```bash
bash scripts/auto-install.sh --yes
```

For a completely manual foreground run, download the matching published
`libravdbd` binary for your OS/architecture, make it executable, and run:

```bash
chmod +x ~/.local/bin/libravdbd
libravdbd serve
```

Foreground mode is useful for release validation, but normal local use should
use the automated installer or an operator-managed service.

### Windows

Windows uses a loopback TCP endpoint by default:

- `tcp:127.0.0.1:37421`

This guide does not yet include a full Windows service-install walkthrough.
For now, use the published Windows daemon asset from the GitHub releases page
and run it under your preferred process supervisor or a manual terminal session.

Foreground manual run:

```bash
libravdbd serve
```

That mode is useful for debugging or validating a local release asset before
you wrap it in `brew services`, `systemd`, or `launchd`.

## Lifecycle Management

### Plugin Lifecycle

- Install the full stack with `npx --yes @xdarkicex/openclaw-memory-libravdb --yes`.
- Update the plugin package with your normal OpenClaw plugin update flow.
- Rerun the installer when daemon assets or local service wiring need repair.
- Disable it by removing the slot assignment from `~/.openclaw/openclaw.json`.

### Daemon Lifecycle

- Start it with `brew services`, `systemd --user`, `launchctl bootstrap`, or a manual `libravdbd serve`.
- Restart it when you change daemon-level environment variables or replace the binary.
- Stop it before uninstalling or deleting on-disk data.
- Point the plugin at the correct endpoint with `sidecarPath` if you do not use the default location.

## Verification

After the plugin and daemon are both in place, run:

```bash
openclaw memory status
```

Healthy output should show that:

- the daemon answered the local health check
- the memory and context-engine slots are active
- the plugin can read stored counts and runtime settings

If OpenClaw cannot reach the daemon, verify the endpoint first:

- macOS/Linux default: `unix:$HOME/.libravdbd/run/libravdb.sock`
- Windows default: `tcp:127.0.0.1:37421`
