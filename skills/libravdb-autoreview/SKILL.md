---
name: libravdb-autoreview
description: Use when closing out review or PR readiness work in the LibraVDB OpenClaw memory plugin, including Codex review target selection, focused plugin tests, plugin-inspector checks, package contents, and real OpenClaw host proof.
---

# LibraVDB Autoreview

Use this workflow after non-trivial edits to the LibraVDB OpenClaw memory plugin, before calling a branch PR-ready, pushing, or shipping.

## Ground Rules

- Start with `git status -sb`; preserve unrelated local changes.
- Prefer native Codex review. Treat findings as advisory and verify each one in the real code path before changing anything.
- Reject speculative edge cases, broad rewrites, and changes that move behavior out of the plugin ownership boundary without a concrete bug.
- If a review-triggered fix changes code, rerun the focused proof and rerun review. Stop when the final review has no accepted/actionable findings.
- Do not push, comment, or open/update a PR unless the user asked for that.

## Pick The Review Target

Dirty local work:

```bash
codex review --uncommitted
```

Use this only when the patch being reviewed is actually in the local worktree. A clean `--uncommitted` review only proves there is no local diff.

Branch or PR work:

```bash
git fetch origin
codex review --base origin/main
```

If an open PR exists, use its real base:

```bash
base=$(gh pr view --json baseRefName --jq .baseRefName)
codex review --base "origin/$base"
```

Already committed single-change work:

```bash
codex review --commit HEAD
```

Do not pass a custom prompt with `--base`, `--commit`, or `--uncommitted`; target review modes generate the native Codex review prompt.

## Focused Proof

For manifest, packaging, skill, and package-content changes:

```bash
./node_modules/.bin/plugin-inspector ci --no-openclaw --runtime --mock-sdk --allow-execute
./node_modules/.bin/tsc -p tsconfig.tests.json
node --test .ts-build/test/integration/checklist-validation.test.js
npm pack --dry-run --json
```

For narrow TypeScript/runtime changes, prefer the smallest direct proof:

```bash
./node_modules/.bin/tsc -p tsconfig.tests.json
node --test .ts-build/test/unit/<file>.test.js
node --test .ts-build/test/integration/<file>.test.js
```

If `pnpm` trips package-manager policy or build-gate prompts, use direct local binaries when that proves the touched surface. Escalate to full `pnpm run check` only when package scripts, dependency graph, generated output, or broad behavior changed and the checkout is healthy.

## Real Host Proof

Mock inspector proof does not prove the plugin loads in a real OpenClaw host. When the question is whether LibraVDB works in OpenClaw, add host-backed proof:

```bash
plugin-inspector ci --openclaw "$(command -v openclaw)" --runtime --real-sdk --allow-execute
openclaw plugins doctor
openclaw memory status --json
openclaw memory search --json memory
```

For daemon, install/update, cross-OS, large reindex, or live gateway behavior, use a real host or remote test box and report the run id or exact runtime evidence. Keep the distinction between repo-only checks, mock inspector checks, and real OpenClaw-backed checks explicit.

## Closeout

Report:

- review command used
- proof commands run
- accepted fixes and rejected findings, with short reasons
- the final clean review result or the remaining consciously rejected finding
