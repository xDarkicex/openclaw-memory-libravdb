# Subagent Memory Access — Design Analysis

## Status

**Architectural gap identified.** `contextMode: "fork"` is dead code. Subagents cannot currently access parent session memories.

---

## Current Implementation

### Subagent Token Budget

```typescript
// context-engine.ts:2040-2044
function normalizeSubagentTokenBudget(value: unknown): number {
  if (typeof value !== "number") return 8000;
  if (!Number.isFinite(value) || value < 0) return 8000;
  return Math.floor(value);
}
```

- Default: 8000 tokens
- `0` disables `memory_expand` entirely
- Budget tracked by `childSessionKey` in `Map<string, BudgetEntry>`

### prepareSubagentSpawn (Dead Code)

```typescript
// context-engine.ts:3173-3205
async prepareSubagentSpawn(params: {
  parentSessionKey: string;
  childSessionKey: string;
  contextMode?: "isolated" | "fork";  // DEFINED BUT NEVER USED
  parentSessionId?: string;
  parentSessionFile?: string;
  childSessionId?: string;
  childSessionFile?: string;
  ttlMs?: number;
}) {
  const budget = normalizeSubagentTokenBudget(cfg.subagentTokenBudget);
  const key = subagentKey(params.childSessionKey);
  subagentBudgets.set(key, { remaining: budget, total: budget, expiresAt: ... });
  // contextMode is never read — no fork/isolate logic exists
}
```

### Session Isolation

```typescript
// memory-runtime.ts:229-253
function resolveSearchCollections(cfg, userId, sessionId, corpus) {
  if (corpus === "sessions") {
    return sessionId ? [resolveSessionSearchCollection(cfg, sessionId)] : [];
  }
  // ...
  // Subagent session collection = session:${subagentSessionId}
  // Parent session collection = session:${parentSessionId}
  // They are DIFFERENT collections — no cross-access
}
```

---

## Lossless-Claw Approach (Reference)

### Session Key Pattern

```
agent:<agentId>:session:<sessionId>      // main agent
agent:<agentId>:subagent:<uuid>          // subagent
```

### Parent Context Passing

```typescript
// Subagent session key encodes parent agentId
const childSessionKey = `agent:${requesterAgentId}:subagent:${crypto.randomUUID()}`
```

### Delegation Grant System

Grants are scoped to specific conversation IDs and bound to the child session key.

### Fork Mode Bootstrap

> "For forked child sessions, LCM treats a host-copied parent JSONL branch as a first-time bootstrap source and imports only the newest messages that fit within `bootstrapMaxTokens`."

---

## Required Implementation

### 1. Session Key Format

Adopt lossless-claw pattern for consistent agent/session encoding:

```
session-key:agent:<agentId>:session:<sessionId>      // main agent
session-key:agent:<agentId>:subagent:<uuid>          // subagent
```

Or simpler (preserve current format but encode parent relationship):

```
<current-session-key>:fork:<parent-session-key>      // fork mode child
```

### 2. Implement contextMode: "fork"

When `contextMode === "fork"`:

1. Store `parentSessionId` in subagent budget entry
2. In `resolveSearchCollections()`, if fork mode and `sessionId` is a child:
   - Include parent's session collection in search scope
3. Subagent can bootstrap from parent's session_summary and session_raw

```typescript
// In subagentBudgets Map
interface SubagentBudgetEntry {
  remaining: number;
  total: number;
  expiresAt: number;
  parentSessionId?: string;  // Added for fork mode
  contextMode: "isolated" | "fork";
}

// In resolveSearchCollections
if (entry.contextMode === "fork" && entry.parentSessionId) {
  collections.push(resolveSessionSearchCollection(cfg, entry.parentSessionId));
}
```

### 3. Per-Agent Config

```typescript
// openclaw.plugin.json configSchema addition
{
  "agentOverrides": {
    "type": "object",
    "additionalProperties": true,
    "description": "Per-agent configuration overrides keyed by agentId"
  }
}
```

Config resolution:

```typescript
function resolveAgentConfig(cfg: PluginConfig, agentId?: string): Partial<PluginConfig> {
  if (!agentId || !cfg.agentOverrides?.[agentId]) {
    return {};
  }
  return cfg.agentOverrides[agentId];
}
```

Usage in budget normalization:

```typescript
function getEffectiveSubagentTokenBudget(cfg: PluginConfig, agentId?: string): number {
  const overrides = resolveAgentConfig(cfg, agentId);
  const value = overrides.subagentTokenBudget ?? cfg.subagentTokenBudget;
  return normalizeSubagentTokenBudget(value);
}
```

### 4. Subagent Session Key Encoding

When OpenClaw spawns a subagent, it provides:
- `ctx.sessionKey` — the child's session key
- `ctx.agentId` — may be different from parent or undefined

We can detect subagent via:
- Session key suffix pattern (if OpenClaw encodes it)
- Parent-child relationship via lifecycle hooks

Current detection (not implemented):

```typescript
// context-engine.ts
function isSubagentSessionKey(sessionKey: string): boolean {
  // Pattern: detect if this is a subagent spawn vs main agent
  // Depends on OpenClaw's session key format for subagents
}
```

---

## OpenClaw Agent Flag

OpenClaw supports `--agent <id>` for multi-agent deployments. The plugin receives `agentId` via `OpenClawPluginToolContext`.

Current handling:
- `LIBRAVDB_AGENT_ID` env var for container/CI override
- `cfg.tenantId` for explicit DB isolation
- `resolveTenantKey()` priority: `tenantId` > `LIBRAVDB_AGENT_ID` > `userId`

For per-agent memory isolation:
- Different `--agent` values → different `agentId` → different collection namespaces
- Agent's subagents inherit same `agentId` in session key pattern

---

## Implementation Priority

| Priority | Item | Description |
|----------|------|-------------|
| P0 | Session key pattern | Define how parent/child relationship is encoded |
| P1 | contextMode: "fork" | Implement parent session access for fork mode |
| P2 | Per-agent config | Add `agentOverrides` to configSchema |
| P3 | Bootstrap token limit | Prevent parent import from exceeding budget |

---

## Files to Modify

- `src/context-engine.ts` — implement fork mode in `prepareSubagentSpawn` and `resolveSearchCollections`
- `src/memory-scopes.ts` — add subagent session key parsing
- `src/openclaw.plugin.json` — add `agentOverrides` to configSchema
- `src/plugin-runtime.ts` — pass agentId to config resolution
- `src/tools/memory-recall.ts` — include parent session in grep when fork mode

---

## Rejected Approaches

### excludeAgents / excludeSubagents

Peetie's proposal to exclude agents from memory injection is a blunt instrument that:
1. Bypasses proper isolation (agents are already isolated by session collection)
2. Cannot grant selective access (all-or-nothing)
3. Doesn't solve the fork use case (subagent needs parent access, not exclusion)

The correct solution is proper fork mode, not exclusion lists.

---

## References

- Lossless-claw: `src/plugin/index.ts:44-59` (session key parsing)
- Lossless-claw: `src/focus-briefs.ts:737` (child session key creation)
- Lossless-claw: `docs/architecture.md:215-224` (fork bootstrap)