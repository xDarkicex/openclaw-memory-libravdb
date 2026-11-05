# Development

This document covers source setup and repository maintenance tasks. For user
installation, use [Install](./install.md).

## Prerequisites

- Node.js `>= 22`
- `pnpm`
- OpenClaw CLI for end-to-end plugin testing
- a published or locally built `libravdbd` vector service for end-to-end testing

Go is only required when building the vector service from a local vector service checkout or
regenerating Go gRPC stubs.

## Source Setup

```bash
pnpm install
pnpm check
```

`pnpm check` runs TypeScript validation, plugin-inspector checks, unit tests,
and integration tests against mocked service contracts:

```bash
tsc --noEmit
pnpm run test:ts
pnpm run test:integration
```

## Local Daemon Build

Prepare `.daemon-bin/libravdbd` for local end-to-end testing:

```bash
bash scripts/build-daemon.sh
```

Supported inputs:

- installed vector service on `PATH`, such as `brew install libravdbd`
- `LIBRAVDBD_BINARY_PATH=/path/to/libravdbd`
- `LIBRAVDBD_SOURCE_DIR=/path/to/libravdbd` to build from a local vector service repo

For vector service-internal Go development and release work, use the separate
`libravdbd` repository.

## Validation Commands

```bash
pnpm check
npm run build
```

Benchmark and tuning commands are documented in
[Performance and tuning](./performance-and-tuning.md).

## Service Contracts and Protos

The plugin imports its generated message types and gRPC client descriptor from
`@xdarkicex/libravdb-contracts` and `@xdarkicex/libravdb-contracts/client`.
The contracts are maintained in a separate package; there is no checked-in
`src/generated/` directory in this repository.

`npm run build` compiles TypeScript, bundles the entry point, and copies the
reference proto files from `api/proto/` into `dist/proto/`:

```bash
npm run build
```

To change the runtime RPC schema, update the contracts package and daemon
together, then update the plugin's contracts dependency and call sites.

## Proto Generation

The repo also contains `api/proto/intelligence_kernel/v1/kernel.proto` and a
legacy `Makefile` target for Go gRPC stub generation:

```bash
make proto
```

That target assumes Homebrew-style locations for `go`, `protoc`, and the Go
plugins, and writes into a `sidecar/` output directory that must exist. It does
not regenerate the TypeScript runtime contracts. For current daemon development,
use the separate `libravdbd` repository and its generation workflow.

## Release Shape

The npm package contains:

- `README.md`
- `HOOK.md`
- `index.js`
- `openclaw.plugin.json`
- `package.json`
- `docs/`
- `dist/`

The package is connect-only. It does not compile Go code, download models, or
manage the vector service process during plugin installation.

## Release Automation

The repository uses these release workflows in `.github/workflows/`:

| Workflow | Trigger | Purpose |
|---|---|--|
| `auto-release.yml` | Merged PR with `release:*` label | Bumps version (patch/minor/major), updates `package.json` and `openclaw.plugin.json`, creates git tag |
| `github-release.yml` | New `v*` tag | Creates a GitHub release |
| `publish.yml` (`publish-npm`) | New stable `v*` tag or manual dispatch | Compiles, verifies versions match, publishes to npm |
| `publish-beta.yml` | New `v*-beta*` tag or manual dispatch | Publishes a prerelease package under the npm beta tag |

To publish: merge a PR with a `release:patch`, `release:minor`, or `release:major`
label. The workflow auto-bumps, tags, and publishes.

## Auto-Install Script

`scripts/auto-install.sh` automates vector service + plugin installation. Run it when
setting up a machine that needs the full stack quickly.
