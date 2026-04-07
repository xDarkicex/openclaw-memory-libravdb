# Packaging Assets

This directory contains Phase 2 daemon-distribution assets for `libravdbd`.

- `systemd/libravdbd.service`: user-service template for Linux.
- `launchd/com.xdarkicex.libravdbd.plist`: LaunchAgent template for macOS.
- `homebrew/libravdbd.rb.tmpl`: source template used to generate a publish-ready Homebrew formula.

The templates assume the default daemon endpoint contract used by the plugin:

- macOS/Linux: `unix:$HOME/.clawdb/run/libravdb.sock`
- Windows: `tcp:127.0.0.1:37421`

## LaunchAgent plist

Before loading the macOS plist, replace:

- `__LIBRAVDBD_PATH__` with the absolute path to the `libravdbd` binary
- `__HOME__` with the current user's home directory
- `__ONNX_RUNTIME_LIB__` with the absolute path to the ONNX runtime shared library (e.g. `/path/to/onnxruntime/onnxruntime-osx-arm64-1.23.0/lib/libonnxruntime.dylib`)

## Provisioning models and runtime

After `postinstall` hooks were removed from the npm package, models and
the ONNX runtime must be provisioned separately.  Use `scripts/provision.sh`:

```bash
bash scripts/provision.sh                     # provisions into .daemon-bin/
bash scripts/provision.sh --target /opt/libravdbd/assets  # custom target
bash scripts/provision.sh --skip-summarizer   # skip optional t5-small model
```

The script downloads models from HuggingFace and the ONNX runtime from
GitHub Releases, verifies SHA-256 checksums, and writes the `embedding.json`
manifests that `libravdbd` needs at startup.  It is idempotent — existing
verified assets are left in place.

The Homebrew formula stages all assets inline during `brew install`.
`provision.sh` is bundled as a repair tool for manual re-provisioning.

## Homebrew formula

The release workflow now generates `dist/libravdbd.rb` from this template using
the release version and SHA-256 files. If `HOMEBREW_TAP_REPO` and
`HOMEBREW_TAP_TOKEN` are configured in GitHub Actions, the workflow also updates
the tap automatically.

The Homebrew formula stages the bundled ONNX Runtime archive, the shipped
embedding profile assets, and the T5 summarizer bundle into the install prefix
so the daemon can boot without an extra asset-unpack step.

Expected GitHub configuration:

- repository variable `HOMEBREW_TAP_REPO`, for example `xDarkicex/homebrew-openclaw-libravdb-memory`
- repository secret `HOMEBREW_TAP_TOKEN` with push access to that tap repo

Template placeholders:

- `__VERSION__`
- `__SHA256_DARWIN_ARM64__`
- `__SHA256_DARWIN_AMD64__`
- `__SHA256_LINUX_ARM64__`
- `__SHA256_LINUX_AMD64__`
- `__SHA256_PROVISION__`
