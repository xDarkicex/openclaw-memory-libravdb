# LibraVDB Memory

## Install

```bash
openclaw plugins install @xdarkicex/openclaw-memory-libravdb
```

The installer builds the Go sidecar, provisions the bundled embedding/runtime assets, optionally provisions the T5 summarizer, and fails fast if the sidecar cannot pass its startup health check.

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
