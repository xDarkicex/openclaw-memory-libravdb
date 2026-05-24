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

Assign `libravdb-memory` to the OpenClaw memory and context-engine slots:

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

The memory slot owns `openclaw memory ...` and memory-runtime calls. The
context-engine slot enables automatic bootstrap, ingest, after-turn, and recall
hooks during sessions.

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

1. `LIBRAVDB_GRPC_ENDPOINT`
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

## Container Layout

In Docker, keep the daemon, model assets, socket, logs, and database in the
same mounted OpenClaw state volume. A typical container-side layout is:

```text
/home/node/.openclaw/bin/libravdbd
/home/node/.openclaw/libravdbd/run/libravdb.sock
/home/node/.openclaw/libravdbd/data.libravdb
/home/node/.openclaw/libravdbd/models/onnxruntime/lib/libonnxruntime.so
/home/node/.openclaw/libravdbd/models/nomic-embed-text-v1.5/embedding.json
```

Start the daemon with explicit local ONNX paths before starting the gateway:

```sh
LIBRAVDB_GRPC_ENDPOINT=unix:/home/node/.openclaw/libravdbd/run/libravdb.sock \
LIBRAVDB_DB_PATH=/home/node/.openclaw/libravdbd/data.libravdb \
LIBRAVDB_ONNX_RUNTIME=/home/node/.openclaw/libravdbd/models/onnxruntime/lib/libonnxruntime.so \
LIBRAVDB_EMBEDDING_MODEL=/home/node/.openclaw/libravdbd/models/nomic-embed-text-v1.5 \
LIBRAVDB_ONNX_DEVICE=cpu \
  /home/node/.openclaw/bin/libravdbd serve
```

Then configure the plugin with the same socket and asset paths:

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

Do not let a container initialize a database with deterministic fallback
embeddings and later switch the same file to ONNX embeddings. Move the fallback
database aside first, then let the daemon create a fresh ONNX-backed store.

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
- `Abstractive model=not provisioned` is acceptable; compaction falls back to
  the extractive path.

## Troubleshooting

### Daemon unavailable

Common causes:

- `libravdbd` is not running for the same user account as OpenClaw
- `sidecarPath` points at the wrong endpoint
- ONNX Runtime assets are missing or unpacked in the wrong place
- a model asset failed checksum validation
- `embeddingBackend` is set to `onnx-local` but `embeddingRuntimePath` or
  `embeddingModelPath` is missing from plugin config

Check the daemon first:

```bash
openclaw memory status
brew services restart libravdbd
```

For foreground debugging:

```bash
libravdbd serve
```

### Deterministic fallback embeddings

If daemon logs mention deterministic fallback mode, the daemon did not find the
configured ONNX runtime or model manifest. Stop the daemon, set
`LIBRAVDB_ONNX_RUNTIME` and `LIBRAVDB_EMBEDDING_MODEL`, confirm the model
directory contains `embedding.json`, then restart. If a database was created
while fallback mode was active, move that `.libravdb` file and its adjacent
`.embedding.json` aside before starting with ONNX assets.

### Incompatible database or embedding profile

If the daemon exits with `database format is incompatible` or `database
embedding profile is incompatible`, it is refusing to open a store whose saved
format or embedding fingerprint differs from the current daemon settings. This
fail-closed behavior protects the store from mixing incompatible vector spaces.

Before changing anything, back up both files for the affected store:

- the database file, such as `$HOME/.libravdbd/data_nomic-embed-text-v1_5.libravdb`
- the adjacent `.embedding.json` metadata file

Then choose one recovery path:

- downgrade to the daemon version that created the store; or
- move the old store aside, start the new daemon so it creates a fresh store,
  and rebuild/reingest memories with the current embedding profile.

This can affect legacy local profiles such as older `all-minilm-l6-v2` setups
when daemon defaults or model metadata change across releases. It is not
expected for stores that stay on the current packaged profiles and assets. See
[Embedding Profiles](./embedding-profiles.md#store-compatibility-and-upgrades)
for more detail.

### Hash mismatch

Do not bypass a checksum mismatch. Delete the corrupt or stale asset and rerun
setup, or republish the release with corrected checksums.

### Default memory still appears active

Confirm that `libravdb-memory` is assigned to both `plugins.slots.memory` and
`plugins.slots.contextEngine`. Without the memory slot, OpenClaw's default
memory path can continue to run in parallel. Without the context-engine slot,
automatic session ingest and recall may not run.

### Lifecycle journal looks empty

The sidecar journal only records advisory lifecycle hints such as `before_reset`
and `session_end`. It is bounded by `lifecycleJournalMaxEntries`, default `500`,
and is not part of normal memory recall.
