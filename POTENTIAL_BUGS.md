# Potential Bugs

Findings from the 2026-06-02 debugging session investigating why user messages are
missing from the daemon database after a Telegram conversation.

## High confidence — confirmed by code reading

### 1. `trimMessagesToBudget` drops oldest messages (including user) when over 2048 tokens

**Location:** `src/context-engine.ts:boundAfterTurnMessagesForIngest` →
`trimMessagesToBudget` (line ~880 area, function definition at `trimMessagesToBudget`).

**Symptom:** When the ingest payload exceeds `AFTER_TURN_INGEST_MAX_TOKENS` (2048),
the function iterates **backwards from the newest** message and drops older ones to
fit the budget. The assistant's reply (always last) is preserved; user messages at the
start of the new-messages slice can be silently dropped.

```ts
for (let i = messages.length - 1; i >= 0; i -= 1) {  // backward iteration
    const cost = approximateMessageTokens(candidate);
    if (used + cost > tokenBudget) {
        continue;  // ← older messages dropped, not newer
    }
    kept.push(candidate);
    used += cost;
}
```

**Status:** Bug exists in **both** current source AND the stale dist (May 31 19:26 build).
Rebuilding alone will not fix it.

**Trigger condition:** Telegram conversation accumulates > 2048 tokens in the
new-messages slice after the manifest overlap.

**Reproduction evidence:** The 2026-06-02 conversation transcript shows the assistant's
reply was stored (score 0.817, search found it), while the user's preceding "okay: I am
planning on moving the causal graph..." message was not findable. (NOTE: the specific
plan message itself is short; if it was dropped, the trigger was the *total* payload,
not the plan message alone.)

**Suggested fix:** Preserve user message + immediate assistant reply as a unit.
Either:
- Walk pairs (user, assistant) and skip pairs that don't fit, never split a pair
- Use a forward-pass that prefers to keep tail messages but never drops a user
  message that has a following assistant message

### 2. `dist/` is stale (May 31 19:26) — source has unbuilt changes

**Location:** `dist/index.js` vs `src/*.ts`

**Symptom:** OpenClaw loads the plugin from `dist/`. The dist was last built on
May 31 19:26, but `package.json` was bumped to 1.8.9 on Jun 1 16:26, and several
commits landed after the dist build:

- `00b85dc feat: expose graph edge metadata in memory_search results`
- `e9639ff feat: session continuity context injection with graceful fallback`
- `f175ce2 fix: sanitize subagent expansion budgets`
- `381c24b fix: declare memory recall tools in manifest`

**Status:** `openclaw upgrade` should have rebuilt dist — verify the upgrade flow
is actually triggering `npm run build`. Until the dist is rebuilt, the running
plugin is functionally 1.8.8-pre (or whatever was committed at May 31 19:24).

**Verification:** `stat dist/index.js` vs `git log --until="May 31 19:26" -1`

## Medium confidence — suspected but not yet proven

### 3. CLI search does not search `session:` collections without `-session`

**Location:** `cmd/search.go:65-69` (in libravdbd, not this repo)

**Symptom:** `libravdbd search -tenant <key> "query"` searches
`user:<key>`, `turns:<key>`, `global` — but NOT `session:<sessionID>`. The
`UpsertSessionTurn` daemon call writes to `session:<sessionID>` for every
ingested message. Without `-session <id>`, those records are invisible to CLI
search.

**Confirmation:** Running `libravdbd search -k 5 -tenant <key> -session <id> "causal graph"`
returns additional results (including the previous agent's reasoning + tool call)
that the no-`-session` variant misses.

**Suggested fix:** Default the CLI to search `session:<sessionID>` for the most
recent session if `-session` is not given. Or: change CLI to also search all
sessions for the tenant.

### 4. Manifest overlap might include the plan message unexpectedly

**Location:** `src/manifest.ts:findOverlapIndex`

**Symptom:** The manifest stores content hashes of ACKed messages. If a
manifest becomes stale (or was reset without daemon confirmation), the next
afterTurn call's `findOverlapIndex` might mark incoming messages as already
known, causing `newMessages.length === 0` and the early-skip path to fire.

**Status:** Cannot confirm without inspecting a real manifest that contains the
plan's hash. The fix `01a595d fix: skip duplicate afterTurn ingestion` added
the explicit "no-new-messages" skip, but the overlap detection itself hasn't
changed.

## Low confidence — observation only

### 5. `selectAfterTurnMessages` slice(-1) fallback

**Location:** `src/context-engine.ts:selectAfterTurnMessages`

**Symptom:** If `prePromptMessageCount >= messages.length` and `messages.length > 0`,
the function returns `messages.slice(-1)` — only the LAST message survives. In a
Telegram context, that's typically the assistant's final reply.

**Status:** Different from #1 (which operates on the post-overlap slice, this
operates on the pre-overlap slice). Would not cause the specific symptom of
"assistant stored, user dropped" because the trim would still preserve the
last user message if it exists in the new slice.

## Diagnostic commands

- `openclaw memory status` — current counts, profile, sidecar health
- `libravdbd status -v --json` — daemon health, cache stats, tenant registry
- `libravdbd search -k 30 -tenant <key> "query"` — see what the DB has
- `ls -lt ~/.openclaw/libravdb-manifests/*.manifest.json | head -5` — see
  which sessions are most recently ACKed
- `cat ~/.openclaw/libravdb-manifests/<session>.manifest.json | jq '.turns | length'`
  — manifest entry count
