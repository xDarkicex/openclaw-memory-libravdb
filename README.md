# LibraVDB Memory

## Install

```bash
openclaw plugins install @xdarkicex/openclaw-memory-libravdb
```

The installer builds the Go sidecar, provisions the bundled embedding/runtime assets, optionally provisions the T5 summarizer, and fails fast if the sidecar cannot pass its startup health check.

Minimum host version:

- OpenClaw `>= 2026.3.22`

Security note:

- `scripts/setup.ts` verifies SHA-256 checksums for downloaded sidecar/runtime/model assets
- the sidecar installer downloads prebuilt sidecar release assets only from `github.com/xDarkicex/openclaw-memory-libravdb` releases
- after install, the plugin makes no required network calls for embedding or extractive compaction
- the only optional runtime network path is an explicitly configured remote summarizer endpoint such as `ollama-local`

## Activate

Add this to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "libravdb-memory"
    }
  }
}
```

Without the `plugins.slots.memory` entry, OpenClaw's default memory continues to run in parallel and this plugin does not take over the exclusive memory slot.

## Verify

Run:

```bash
openclaw memory status
```

Expected output includes a readable status table showing the sidecar is running, stored turn/memory counts, the active ingestion gate threshold, and whether the abstractive summarizer is provisioned.
