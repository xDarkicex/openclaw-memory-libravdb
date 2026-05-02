# Development

This document covers source setup and repository maintenance tasks. For user
installation, use [Install](./install.md).

## Prerequisites

- Node.js `>= 22`
- `pnpm`
- OpenClaw CLI for end-to-end plugin testing
- a published or locally built `libravdbd` daemon for integration tests

Go is only required when building the daemon from a local daemon checkout or
regenerating Go gRPC stubs.

## Source Setup

```bash
pnpm install
pnpm check
```

`pnpm check` runs TypeScript validation and unit tests:

```bash
tsc --noEmit
tsc -p tsconfig.tests.json && node --test .ts-build/test/unit/*.test.js
```

## Local Daemon Build

Prepare `.daemon-bin/libravdbd` for local plugin testing:

```bash
bash scripts/build-daemon.sh
```

Supported inputs:

- installed daemon on `PATH`, such as `brew install libravdbd`
- `LIBRAVDBD_BINARY_PATH=/path/to/libravdbd`
- `LIBRAVDBD_SOURCE_DIR=/path/to/libravdbd` to build from a local daemon repo

For daemon-internal Go development and release work, use the separate
`libravdbd` repository.

## Validation Commands

```bash
pnpm check
npm run test:integration
```

Benchmark and tuning commands are documented in
[Performance and tuning](./performance-and-tuning.md).

## Generated IPC Files

The plugin imports generated IPC envelope and RPC payload classes from
`src/generated/libravdb/ipc/v1/rpc_pb.js`.

Those generated files are checked in and copied into `dist/generated/` during
`npm run build`:

```bash
npm run build
```

Do not replace those imports with the older external
`@xdarkicex/libravdb-contracts` path. The current package resolves generated
types from this repository.

## Proto Generation

The repo also contains `api/proto/intelligence_kernel/v1/kernel.proto` and a
small `Makefile` target for Go gRPC stub generation:

```bash
make proto
```

That target assumes Homebrew-style locations for `go`, `protoc`, and the Go
plugins. Adjust the Makefile locally if your toolchain lives elsewhere.

## Release Shape

The npm package contains:

- `README.md`
- `HOOK.md`
- `index.js`
- `cli-metadata.js`
- `openclaw.plugin.json`
- `package.json`
- `docs/`
- `dist/`

The package is connect-only. It does not compile Go code, download models, or
manage the daemon process during plugin installation.

## Release Automation

The repository uses three CI workflows in `.github/workflows/`:

| Workflow | Trigger | Purpose |
|---|---|--|
| `auto-release.yml` | Merged PR with `release:*` label | Bumps version (patch/minor/major), updates `package.json` and `openclaw.plugin.json`, creates git tag |
| `github-release.yml` | New `v*` tag | Creates a GitHub release |
| `publish.yml` (`publish-npm`) | New `v*` tag or manual dispatch | Compiles, verifies versions match, publishes to npm |

To publish: merge a PR with a `release:patch`, `release:minor`, or `release:major`
label. The workflow auto-bumps, tags, and publishes.

## Auto-Install Script

`scripts/auto-install.sh` automates daemon + plugin installation. Run it when
setting up a machine that needs the full stack quickly.
