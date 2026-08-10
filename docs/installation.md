# Installation Reference

This is the full installation reference for
`@xdarkicex/openclaw-memory-libravdb`. For the shortest path, use
[install.md](./install.md).

## System Requirements

| Requirement | Minimum | Notes |
|---|---:|---|
| Node.js | `22.0.0` | Enforced by `package.json` `engines.node`. |
| OpenClaw | `2026.3.22` | Earliest supported host version for this plugin API shape. |
| `libravdbd` | published vector service asset | Required for normal runtime. |
| Go | `1.22` | Required only for local vector service development. |
| OS | macOS, Linux, Windows | Unix uses a local socket; Windows uses TCP loopback. |
| Architecture | `arm64`, `x64` | Must match the vector service release asset. |

Resource sizing and benchmark data live in
[Performance and tuning](./performance-and-tuning.md).

OpenClaw compatibility note:

- the plugin is currently verified against OpenClaw `2026.5.22`

## Install Flow

The published plugin package is connect-only. It installs TypeScript plugin code
and docs; it does not compile Go code, download model assets, or supervise the
vector service.

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
Use the published Windows vector service asset under your preferred process supervisor
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

The memory slot owns `openclaw libravdb ...` and memory-runtime calls. The
context-engine slot enables automatic bootstrap, ingest, after-turn, and recall
hooks during sessions.

If the vector service uses a non-default endpoint, add `sidecarPath`:

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

In Docker, keep the vector service, model assets, socket, logs, and database in the
same mounted OpenClaw state volume. A typical container-side layout is:

```text
/home/node/.openclaw/bin/libravdbd
/home/node/.openclaw/libravdbd/run/libravdb.sock
/home/node/.openclaw/libravdbd/data.libravdb
/home/node/.openclaw/libravdbd/models/onnxruntime/lib/libonnxruntime.so
/home/node/.openclaw/libravdbd/models/nomic-embed-text-v1.5/embedding.json
```

Start the vector service with explicit local ONNX paths before starting the gateway:

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
database aside first, then let the vector service create a fresh ONNX-backed store.

## Verification

Run:

```bash
openclaw libravdb status
```

Expected output shape:

```text
┌────────────────────┬──────────────────────────────┐
│ Daemon             │ running                      │
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

- `Daemon=running` means the vector service answered the health check.
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

Check the vector service first:

```bash
openclaw libravdb status
brew services restart libravdbd
```

For foreground debugging:

```bash
libravdbd serve
```

### Deterministic fallback embeddings

If the vector service falls back to deterministic embeddings, it could not locate
the configured ONNX runtime or model assets. The service will still run but all
embedding operations will fail until resolved.

To resolve: stop the vector service, then set `LIBRAVDB_ONNX_RUNTIME` to the
full path of the ONNX runtime library (e.g. `libonnxruntime.so` or
`libonnxruntime.dylib`) and `LIBRAVDB_EMBEDDING_MODEL` to the model directory
containing `embedding.json`. Verify the model directory also contains the
corresponding `.onnx` model file and `tokenizer.json`.

If a database was created while the service was in fallback mode, move that
`.libravdb` file and its adjacent `.embedding.json` aside before restarting —
a store initialized with deterministic embeddings is incompatible with ONNX-backed
operation.

### Incompatible database or embedding profile

If the vector service exits with `database format is incompatible` or `database
embedding profile is incompatible`, it is refusing to open a store whose saved
format or embedding fingerprint differs from the current vector service settings. This
fail-closed behavior protects the store from mixing incompatible vector spaces.

Before changing anything, back up both files for the affected store:

- the database file, such as `$HOME/.libravdbd/data_nomic-embed-text-v1_5.libravdb`
- the adjacent `.embedding.json` metadata file

Then choose one recovery path:

- downgrade to the vector service version that created the store; or
- move the old store aside, start the new vector service so it creates a fresh store,
  and rebuild/reingest memories with the current embedding profile.

This can affect legacy local profiles such as older `all-minilm-l6-v2` setups
when vector service defaults or model metadata change across releases. It is not
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

The vector service journal only records advisory lifecycle hints such as `before_reset`
and `session_end`. It is bounded by `lifecycleJournalMaxEntries`, default `500`,
and is not part of normal memory recall.
