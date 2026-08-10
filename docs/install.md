# Install Guide

LibraVDB Memory is a connect-only OpenClaw plugin. Install the plugin as a
normal package, install `libravdbd` separately, and point the plugin at the
vector service endpoint when you need a non-default location.

OpenClaw compatibility note:

- the plugin is currently verified against OpenClaw `2026.5.22`

For deeper operational detail, use the full
[installation reference](./installation.md).

## Recommended Path: Homebrew + OpenClaw Plugin

On macOS, the shortest supported path is:

```bash
brew tap xDarkicex/homebrew-openclaw-libravdb-memory
brew install libravdbd
brew services start libravdbd
openclaw plugins install @xdarkicex/openclaw-memory-libravdb
```

This gives you:

- a managed `libravdbd` service
- a scanner-clean plugin install
- a clean separation between plugin lifecycle and vector service lifecycle

## Plugin Install

Install the plugin package with the OpenClaw CLI:

```bash
openclaw plugins install @xdarkicex/openclaw-memory-libravdb
```

If you use the OpenClaw.ai plugin UI instead of the CLI, install the same
package and then assign the plugin id `libravdb-memory` to the `memory` and
`contextEngine` slots.

Activate the plugin in `~/.openclaw/openclaw.json`:

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

If you run the vector service on a non-default endpoint, add a plugin config:

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

1. `LIBRAVDB_GRPC_ENDPOINT` if it is set to a valid vector service endpoint
2. `$HOME/.libravdbd/run/libravdb.sock` if it exists
3. `/opt/homebrew/var/libravdbd/run/libravdb.sock` if it exists
4. `/usr/local/var/libravdbd/run/libravdb.sock` if it exists
5. fallback to `$HOME/.libravdbd/run/libravdb.sock`

## Vector Service Install

The vector service owns the local database, embeddings, and gRPC endpoint.

Default endpoints:

- Homebrew on macOS (Apple Silicon): `unix:/opt/homebrew/var/libravdbd/run/libravdb.sock`
- Homebrew on macOS (Intel): `unix:/usr/local/var/libravdbd/run/libravdb.sock`
- macOS/Linux user-local installs: `unix:$HOME/.libravdbd/run/libravdb.sock`
- Windows: `tcp:127.0.0.1:37421`

Default data path:

- macOS/Linux user installs: `$HOME/.libravdbd/data_nomic-embed-text-v1_5.libravdb`
- Windows user installs: `%USERPROFILE%\.libravdbd\data_nomic-embed-text-v1_5.libravdb`

### Homebrew

Homebrew is the preferred vector service lifecycle on macOS:

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

If you are not using Homebrew, manage the vector service explicitly.

Linux user service from the repo template:

```bash
# Replace vX.Y.Z with the published libravdbd release you want to install.
mkdir -p ~/.local/bin ~/.config/systemd/user
# Download the matching published libravdbd binary and service template.
curl -L -o ~/.local/bin/libravdbd <published-libravdbd-binary-url>
chmod +x ~/.local/bin/libravdbd
curl -L -o ~/.config/systemd/user/libravdbd.service <published-libravdbd-service-template-url>
systemctl --user enable --now libravdbd.service
```

macOS LaunchAgent from the repo template:

1. Download the published `com.xdarkicex.libravdbd.plist` template for your release.
2. Replace `__HOME__` with your home directory.
3. Save it to `~/Library/LaunchAgents/com.xdarkicex.libravdbd.plist`.
4. Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.xdarkicex.libravdbd.plist`.

### Windows

Windows uses a loopback TCP endpoint by default:

- `tcp:127.0.0.1:37421`

This guide does not yet include a full Windows service-install walkthrough.
For now, use the published Windows vector service asset from the GitHub releases page
and run it under your preferred process supervisor or a manual terminal session.

Foreground manual run:

```bash
libravdbd serve
```

That mode is useful for debugging or validating a local release asset before
you wrap it in `brew services`, `systemd`, or `launchd`.

### Containers and Docker

The npm plugin does not start `libravdbd`. In a container, either run a separate
vector service or use a small entrypoint wrapper that starts the vector service before
the OpenClaw gateway.

Keep the vector service assets and database in a mounted volume and point both the
vector service and plugin at paths inside the container:

```sh
export LIBRAVDB_GRPC_ENDPOINT=unix:/home/node/.openclaw/libravdbd/run/libravdb.sock
export LIBRAVDB_DB_PATH=/home/node/.openclaw/libravdbd/data.libravdb
export LIBRAVDB_ONNX_RUNTIME=/home/node/.openclaw/libravdbd/models/onnxruntime/lib/libonnxruntime.so
export LIBRAVDB_EMBEDDING_MODEL=/home/node/.openclaw/libravdbd/models/nomic-embed-text-v1.5
export LIBRAVDB_ONNX_DEVICE=cpu
libravdbd serve &

# Wait for socket to be ready
for i in {1..30}; do
  [ -S "$LIBRAVDB_GRPC_ENDPOINT" ] && break
  sleep 0.5
done

node dist/index.js gateway --bind lan --port 18789
```

Use matching plugin config:

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
          "sidecarPath": "unix:/home/node/.openclaw/libravdbd/run/libravdb.sock",
          "embeddingBackend": "onnx-local",
          "embeddingRuntimePath": "/home/node/.openclaw/libravdbd/models/onnxruntime/lib/libonnxruntime.so",
          "embeddingModelPath": "/home/node/.openclaw/libravdbd/models/nomic-embed-text-v1.5",
          "onnxDevice": "cpu"
        }
      }
    }
  }
}
```

For public bots, deny manual memory tools unless users are supposed to query the
store directly. The context engine can still use LibraVDB for recall while
`memory_search` and `memory_get` remain unavailable to channel users.

## Lifecycle Management

### Plugin Lifecycle

- Install the package with `openclaw plugins install`.
- Activate it by assigning `libravdb-memory` to the `memory` and
  `contextEngine` slots.
- Update it with your normal OpenClaw plugin update flow.
- Disable it by removing the slot assignment from `~/.openclaw/openclaw.json`.

The plugin does not manage the vector service process. Treat plugin activation and
vector service supervision as separate lifecycle decisions.

### Daemon Lifecycle

- Start it with `brew services`, `systemd --user`, `launchctl bootstrap`, or a manual `libravdbd serve`.
- Restart it when you change vector service-level environment variables or replace the binary.
- Stop it before uninstalling or deleting on-disk data.
- Point the plugin at the correct endpoint with `sidecarPath` if you do not use the default location.

## Verification

After the plugin and vector service are both in place, run:

```bash
openclaw libravdb status
```

Healthy output should show that:

- the vector service answered the local health check
- the memory and context-engine slots are active
- the plugin can read stored counts and runtime settings

If OpenClaw cannot reach the vector service, verify the endpoint first:

- macOS/Linux default: `unix:$HOME/.libravdbd/run/libravdb.sock`
- Windows default: `tcp:127.0.0.1:37421`
