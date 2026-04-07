# OpenClaw Plugin Compatibility Audit (2026-04)

This document recreates the lost internal audit for the OpenClaw plugin patch
that tightened dual-kind plugin behavior and records the current compatibility
status of `libravdb-memory` against that contract.

## Scope

Audited upstream OpenClaw patch:

- `d81e67d54b2f70d90016bcf2696d09f251492a8f`
- subject: `plugins: include default slot ownership in disable checks and gate dual-kind memory registration`

Audited current libraVDB plugin surfaces:

- [`openclaw.plugin.json`](../openclaw.plugin.json)
- [`src/index.ts`](../src/index.ts)
- [`src/memory-runtime.ts`](../src/memory-runtime.ts)
- [`src/openclaw-plugin-sdk.d.ts`](../src/openclaw-plugin-sdk.d.ts)
- [`docs/implementation.md`](./implementation.md)
- [`docs/installation.md`](./installation.md)
- [`test/integration/checklist-validation.test.ts`](../test/integration/checklist-validation.test.ts)
- [`test/unit/memory-runtime.test.ts`](../test/unit/memory-runtime.test.ts)

## Upstream Patch Summary

The OpenClaw patch changed two parts of plugin behavior that matter for
`kind: ["memory", "context-engine"]` plugins.

1. Slot disable checks now consider default slot ownership, not only explicit
   `plugins.slots.*` config.
2. Dual-kind plugins may remain enabled for a non-memory role, but they may no
   longer register memory-only surfaces unless they actually own the `memory`
   slot.

In practice, OpenClaw now treats these surfaces as memory-slot-scoped:

- `registerMemoryPromptSection(...)`
- `registerMemoryFlushPlan(...)`
- `registerMemoryRuntime(...)`
- `registerMemoryEmbeddingProvider(...)`

OpenClaw emits warnings and skips those registrations when a dual-kind plugin is
active for some other role but is not the selected memory plugin.

## Why This Matters For LibraVDB

`libravdb-memory` is intentionally a dual-kind plugin:

- manifest kind: `["memory", "context-engine"]`
- intended slot ownership: both `memory` and `contextEngine`

That design means the plugin sits directly on the boundary tightened by the
upstream patch.

Before this contract was understood clearly, there were five compatibility
concerns:

1. missing memory runtime
2. missing flush-plan/tool contract
3. stale dual-kind assumptions
4. stale config and operator docs
5. local SDK shim drift

## Current Status

### 1. Memory runtime

Status: addressed

Current code registers a memory runtime bridge when the host exposes the newer
API:

- [`src/index.ts`](../src/index.ts) calls
  `api.registerMemoryRuntime?.(buildMemoryRuntimeBridge(...))`
- [`src/memory-runtime.ts`](../src/memory-runtime.ts) provides the bridge used
  by built-in memory search surfaces
- [`test/unit/memory-runtime.test.ts`](../test/unit/memory-runtime.test.ts)
  verifies search and status behavior

Compatibility consequence:

- when `libravdb-memory` owns the `memory` slot, the host can route built-in
  `memory_search` behavior into libraVDB
- when it does not own the `memory` slot, OpenClaw is expected to skip this
  registration for the plugin, which is now the correct behavior

### 2. Memory flush plan

Status: intentionally deferred

The plugin does not currently register `registerMemoryFlushPlan(...)`.

This is documented explicitly in:

- [`docs/implementation.md`](./implementation.md)
- [`docs/installation.md`](./installation.md)

Current design intent:

- ingest and compaction remain owned by the context-engine lifecycle and the
  sidecar
- the runtime bridge is additive for search and status only
- a host flush-plan hook should not be added until it can map cleanly onto the
  existing ingest and compaction model without duplicate transcript handling

Audit conclusion:

- this is not a regression against the audited OpenClaw patch
- it remains a future compatibility watchpoint if OpenClaw starts depending more
  heavily on plugin-provided flush plans for first-class memory behavior

### 3. Dual-kind assumptions

Status: addressed in code and docs

The repo now reflects the stricter contract clearly:

- [`openclaw.plugin.json`](../openclaw.plugin.json) declares
  `kind: ["memory", "context-engine"]`
- [`README.md`](../README.md) states that the plugin should own both slots and
  that partial slot assignment is a misconfiguration
- [`docs/installation.md`](./installation.md) repeats the same operational rule
- [`test/integration/checklist-validation.test.ts`](../test/integration/checklist-validation.test.ts)
  locks the dual-kind registration shape in place

Audit conclusion:

- the repo no longer assumes that dual-kind registration alone is sufficient
- it correctly treats slot ownership as part of the runtime contract

### 4. Config and operator docs

Status: addressed

The current docs now describe the exact activation shape required by the newer
OpenClaw behavior:

- assign both `plugins.slots.memory` and `plugins.slots.contextEngine` to
  `libravdb-memory`
- treat partial slot assignment as misconfiguration
- understand that `registerMemoryRuntime` is additive and `registerMemoryFlushPlan`
  is still deferred

This closes the main operator-facing risk introduced by the upstream patch:
users configuring only one slot and expecting the full libraVDB lifecycle to
remain active.

### 5. SDK shim drift

Status: reduced, but still a watchpoint

The repository now includes the newer optional plugin API members in its local
TypeScript augmentation:

- `registerMemoryFlushPlan?`
- `registerMemoryRuntime?`
- `registerMemoryEmbeddingProvider?`

See [`src/openclaw-plugin-sdk.d.ts`](../src/openclaw-plugin-sdk.d.ts).

Audit conclusion:

- the local shim is no longer missing the key memory runtime seam
- however, any local shim remains vulnerable to future OpenClaw SDK evolution
  if the host adds or tightens plugin API signatures again

## Concrete Impact Of The Upstream Patch

For this plugin, the audited OpenClaw patch means:

1. If users assign both slots to `libravdb-memory`, the plugin shape is aligned
   with the host contract.
2. If users assign only `contextEngine`, the plugin can still remain active as a
   context engine, but OpenClaw may skip memory-only registrations. That is why
   partial assignment is documented as misconfiguration.
3. If users assign only `memory`, the memory-specific surfaces can register, but
   the repo's intended lifecycle is still incomplete because the plugin is
   designed to own both exclusive roles together.
4. If another plugin owns `memory`, `libravdb-memory` should no longer expect to
   expose memory prompt, runtime, or embedding surfaces merely because it is
   enabled for `contextEngine`.

## Remaining Risks

The current repo appears compatible with the audited patch, but a few risks
remain.

### Partial slot assignment

The plugin design is intentionally coupled across `memory` and `contextEngine`.
That is documented, but OpenClaw still permits users to configure slots
independently. Misconfiguration remains possible.

### Flush-plan evolution upstream

If OpenClaw starts treating plugin flush plans as a stronger expectation for
memory feature parity, this repo will need a host-facing flush-plan bridge that
does not duplicate the sidecar-owned ingest path.

### SDK surface drift

The local `openclaw-plugin-sdk.d.ts` shim is a practical compatibility layer,
but it is not the same as consuming a frozen external SDK package. Future host
changes can still outrun it.

## Audit Result

Result: compatible with the audited OpenClaw patch, with one intentional gap.

Summary:

- memory runtime support is now present
- dual-kind slot ownership assumptions are now explicit
- activation and operator docs match the stricter host behavior
- SDK shim coverage includes the key newer memory hooks
- memory flush-plan registration is still intentionally deferred

That means the original audit findings were valid for the older installed plugin
snapshot, but the current repository has already closed most of those gaps.
What remains is not a hidden incompatibility from `d81e67d54b`; it is an
explicit design choice around flush-plan ownership and a standing need to keep
the local SDK shim synchronized with OpenClaw.
