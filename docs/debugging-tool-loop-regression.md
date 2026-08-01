# Tool Call Loop Regression: v1.8.9 → v1.9.7

## Symptoms
- LLM outputs verbatim text twice in a single turn
- LLM executes the same tool call (image gen) twice in a single turn
- **Intermittent** — does NOT reproduce on every turn; ~50% hit rate
- **Tool-call-gated** — only occurs on turns involving tool calls (image gen, file ops, etc.). Plain text conversations never trigger it.
- "Didn't used to happen" — confirmed clean in v1.8.7–1.8.9
- First observed after v1.9.0 perf rewrite + v1.9.1 live tool protocol changes
- Affects provider models broadly (MiniMax M2.7 confirmed); Qwen 3.5 32B INT4 was the target model for the live tool protocol harness

**Intermittent nature → race condition, not deterministic logic bug. Tool-only gating → the race specifically affects turns where the daemon's context replay contains tool protocol from the prior turn.**

## Observations

### O1: ~50% hit rate, tool calls only
Duplication happens roughly half the time on tool call turns. It never triggers on plain text conversations. This narrows the scope to the tool protocol code paths — specifically the cursor-based gates that only activate when `hasKernelToolCallBlock` or `isToolResultRole` match.

### O2: Async ingestion timing window
The 50/50 split is consistent with a two-processor race: the LLM provider response time (variable, 2-8s) vs the daemon `afterTurn` ingestion time (variable, 0.5-3s). When the provider is slow and ingestion is fast, the async queue drains before the next `assemble()` — no race. When the provider is fast and the daemon is busy (compaction, embedding), the queue hasn't drained — race triggers.

### O3: Regular conversation is immune
Text-only turns have no tool protocol to classify. The live tool protocol gates (`consumeLiveToolAtCursor`, `findLiveToolSourceInCurrentTurn`) are never entered. The provider replay dedup handles plain text correctly. The race only matters when tool protocol exists in the transcript.

## Timeline

| Version | Key Change | Author |
|---------|-----------|--------|
| v1.8.9 | Last known-good | — |
| v1.9.0 | Perf rewrite: async ingestion, O(1) indexing, memoization caches | Juan |
| v1.9.1 | Live tool protocol preservation (`78da771`, 164 loc) | Juan |
| v1.9.4 | Provider replay dedup with source-index awareness | xDarkicex |
| v1.9.5 | Tool result annotation fix: `[^\n]*` → `\s*` | xDarkicex |
| v1.9.7 | Assemble deadline (30s) | xDarkicex |

## Theory: Live Tool Protocol Harness Feeds Tool Output Back to Model

The primary suspect is commit `78da771` ("preserve live tool protocol during context assembly", v1.9.0 → v1.9.1). It added a cursor-guarded tool protocol preservation system that re-injects the current turn's tool calls and results from the source transcript into the assembled context, bypassing the provider replay dedup.

**Mechanism:** When the daemon's `assemble()` returns context messages that include historical tool protocol from a prior turn, the `consumeLiveToolAtCursor` and `findLiveToolSourceInCurrentTurn` functions match these against the source transcript. If they match, the original (unsanitized) source message is pushed into context **directly, bypassing the provider-replay dedup** (line 1921).

This works for Qwen 3.5 32B INT4 which needed full tool context to avoid orphaned tools. But for other models, injecting the full tool call JSON + tool result JSON from a prior turn into the next turn's context causes the model to treat it as a new instruction — re-executing the tool and repeating the output.

## Code Comparison

### Message Processing Loop

**v1.8.9** — Simple, flat. One tool gate, then provider replay or memory:
```typescript
// v1.8.9 — src/context-engine.ts ~line 1525
if (Array.isArray(result.messages)) {
  for (const message of result.messages) {
    const content = normalizeKernelContent(message.content);
    const historicalToolSource = getHistoricalToolSource(message.role, message.content, content);
    let isRealTranscript = false;

    if (sourceMessages) {
      // O(n²) linear scan — simple, correct
      isRealTranscript = sourceMessages.some((sm) => {
        if (message.id && sm.id === message.id) return true;
        if (sm.role === message.role && normalizeKernelContent(sm.content) === content) return true;
        return false;
      });
    } else {
      isRealTranscript = message.role === "user" || message.role === "assistant";
    }

    // SINGLE tool gate — preserve or drop, simple boolean
    if (isLiveToolProtocolMessage(message, content, sourceMessages)) {
      messages.push(preserveLiveToolProtocolMessage(message));
    } else if (isRealTranscript && !historicalToolSource && isProviderReplayRole(message.role)) {
      // Provider replay — NO dedup, simple push
      const sanitizedContent = sanitizeToolCallPatterns(content, {
        stripOpenClawDirectives: message.role === "assistant",
      });
      if (isHistoricalAssistantActionPromise(message.role, sanitizedContent)) {
        continue;
      }
      // Push without dedup — works because daemon doesn't duplicate
      messages.push({
        role: message.role,
        content: sanitizedContent,
        ...(typeof message.id === "string" ? { id: message.id } : {}),
      });
    } else {
      // Memory items only
      if (content.trim().length > 0) {
        const sanitizedContent = sanitizeToolCallPatterns(content, {
          stripOpenClawDirectives: message.role !== "user",
        });
        if (sanitizedContent.trim().length > 0 &&
            shouldRetainHistoricalToolMemory(message.role, historicalToolSource, sanitizedContent)) {
          pushMemoryItem({ content: sanitizedContent, role: message.role, provenance: ... });
        }
      }
    }
  }
}
```

**v1.9.7** — Complex, cursor-guarded. THREE tool gates, source-index-aware dedup:
```typescript
// v1.9.7 — src/context-engine.ts ~line 1894
if (Array.isArray(result.messages)) {
  const lastUserIndex = sourceMessages ? findLastUserMessageIndex(sourceMessages) : -1;
  let liveSourceCursor = sourceMessages ? lastUserIndex + 1 : undefined;
  let providerReplaySourceCursor: number | undefined = sourceMessages ? 0 : undefined;
  for (const message of result.messages) {
    const content = normalizeKernelContent(message.content);
    const historicalToolSource = getHistoricalToolSource(message.role, message.content, content);
    let isRealTranscript = false;
    if (sourceMessages) {
      isRealTranscript = findMatchingSourceMessageIndex(message, content, sourceMessages) >= 0;
    } else {
      isRealTranscript = message.role === "user" || message.role === "assistant";
    }

    // GATE 1: consumeLiveToolAtCursor — cursor-guarded, pushes source message directly
    const liveToolProtocolSource = consumeLiveToolAtCursor(
      message, content, sourceMessages, liveSourceCursor,
      lastUserIndex >= 0 ? lastUserIndex : undefined,
    );
    if (liveToolProtocolSource) {
      // ⚠️ PUSHES DIRECTLY — bypasses provider-replay dedup entirely (line 1921)
      messages.push(preserveLiveToolProtocolMessage(liveToolProtocolSource.message));
      liveSourceCursor = liveToolProtocolSource.index + 1;
    }
    // GATE 2: findLiveToolSourceInCurrentTurn — additional skip gate
    else if (findLiveToolSourceInCurrentTurn(message, content, sourceMessages, undefined,
             lastUserIndex >= 0 ? lastUserIndex : undefined) >= 0) {
      // ⚠️ Silently skips — message is dropped
      if (liveSourceCursor !== undefined && sourceMessages) {
        const idx = findMatchingSourceMessageIndex(message, content, sourceMessages, liveSourceCursor);
        if (idx >= liveSourceCursor) liveSourceCursor = idx + 1;
      }
      continue;
    }
    // GATE 3: Historical tool derived — filters assistant replies after tool protocol
    else if (isRealTranscript && !historicalToolSource && isProviderReplayRole(message.role)) {
      if (isHistoricalToolDerivedAssistantReply(message, content, sourceMessages)) {
        // ... cursor advance, continue
      }
      const sanitizedContent = sanitizeToolCallPatterns(content, {
        stripOpenClawDirectives: message.role === "assistant",
      });
      if (isHistoricalAssistantActionPromise(message.role, sanitizedContent)) {
        // ... cursor advance, continue
      }
      // ⚠️ pushProviderReplayMessage — has dedup, but only for provider replay path
      const providerReplaySourceIndex = sourceMessages
        ? findMatchingSourceMessageIndex(message, content, sourceMessages, providerReplaySourceCursor)
        : undefined;
      pushProviderReplayMessage(
        { role: message.role, content: sanitizedContent, ... },
        providerReplaySourceIndex,
      );
    }
    else {
      // Memory items
      // ...
    }
  }
}
```

### Live Tool Protocol Functions

**v1.8.9** — Simple boolean check:
```typescript
function isLiveToolProtocolMessage(
  message: { role: string; content?: unknown; id?: string },
  normalizedContent: string,
  sourceMessages: OpenClawCompatibleMessage[] | undefined,
): boolean {
  if (!sourceMessages) return false;
  if (!isToolResultRole(message.role) && !hasKernelToolCallBlock(message.content)) return false;

  const lastUserIndex = findLastUserMessageIndex(sourceMessages);
  const sourceIndex = findMatchingSourceMessageIndex(
    message, normalizedContent, sourceMessages, lastUserIndex + 1,
  );
  if (sourceIndex < 0) return false;
  if (sourceIndex <= lastUserIndex) return false;
  if (hasCompletedAssistantResponseAfter(sourceMessages, sourceIndex)) return false;
  if (hasKernelToolCallBlock(message.content)) return true;
  return hasLiveToolCallBefore(sourceMessages, lastUserIndex, sourceIndex, getToolResultCallId(message));
}
```

**v1.9.7** — Cursor-guarded, returns source message + index for position tracking:
```typescript
function findLiveToolSourceInCurrentTurn(
  message: { role: string; content?: unknown; id?: string; [key: string]: unknown },
  normalizedContent: string,
  sourceMessages: OpenClawCompatibleMessage[] | undefined,
  preferredStartIndex?: number,
  providedLastUserIndex?: number,
): number {
  if (!sourceMessages) return -1;
  // ⚠️ Allow assistant messages through — daemon flattens structured toolCall blocks into
  // [tool:name] text, which no longer triggers hasKernelToolCallBlock
  if (!isToolResultRole(message.role) && message.role !== "assistant" && !hasKernelToolCallBlock(message.content)) {
    return -1;
  }

  const lastUserIndex = providedLastUserIndex ?? findLastUserMessageIndex(sourceMessages);
  if (lastUserIndex < 0) return -1;
  const searchStartIndex = preferredStartIndex === undefined
    ? lastUserIndex + 1
    : Math.max(lastUserIndex + 1, preferredStartIndex);
  const sourceIndex = findMatchingSourceMessageIndex(message, content, sourceMessages, searchStartIndex);
  if (sourceIndex < searchStartIndex) return -1;
  if (hasCompletedAssistantResponseAfter(sourceMessages, sourceIndex)) return -1;

  const sourceMessage = sourceMessages[sourceIndex];
  if (!sourceMessage) return -1;
  if (sourceMessage.role === "assistant" && hasKernelToolCallBlock(sourceMessage.content)) {
    return sourceIndex;
  }
  if (isToolResultRole(sourceMessage.role)) {
    const toolCallId = getToolResultCallId(sourceMessage) ?? getToolResultCallId(message);
    if (hasLiveToolCallBefore(sourceMessages, lastUserIndex, sourceIndex, toolCallId)) {
      return sourceIndex;
    }
  }
  return -1;
}
```

Key difference: v1.9.7 added `message.role !== "assistant"` as an allow condition — daemon-flattened `[tool:name]` text from assistant messages now passes through where v1.8.9's `hasKernelToolCallBlock` would have filtered them.

## Theories

### T0: Async ingestion races with next assemble() — cursor base shifts (HIGHEST)

v1.9.0 (commit `20dc976`, PR #329) made `afterTurn` ingestion asynchronous — it's enqueued via `enqueueAsyncIngestion()` instead of `await`ed inline. The daemon call that ingests the assistant's tool call response may complete AFTER the next `assemble()` starts.

When this race hits:
1. Turn N finishes. LLM generated "An army of me" + `[tool:image_gen]`.
2. `afterTurn` is enqueued but hasn't completed yet.
3. Turn N+1 starts. User sends next message. `assemble()` runs.
4. The source transcript passed to `normalizeAssembleResult` does NOT yet include the assistant's tool call response from turn N.
5. `consumeLiveToolAtCursor` and `findLiveToolSourceInCurrentTurn` compute cursors against a stale transcript.
6. When the async afterTurn FINALLY completes, the next `assemble()` NOW sees the tool protocol in the transcript — cursor behavior changes.
7. Depending on provider latency and message cadence, the race hits ~30-50% of turns.

This explains the intermittency perfectly. Before v1.9.0, `afterTurn` was synchronous — the daemon call completed before the LLM response started streaming. The source transcript was always up-to-date. The cursor was always computed against a complete transcript.

**Evidence for T0:**
- Intermittent, ~50% hit rate → timing-dependent, not a code path always taken
- Only occurs on tool call turns (O1) → the race specifically affects cursor-based tool protocol classification
- Regular conversations are immune (O3) → `consumeLiveToolAtCursor` / `findLiveToolSourceInCurrentTurn` are only entered when tool protocol exists
- 50/50 split matches two-variable race window (O2) — provider latency 2-8s vs daemon ingest latency 0.5-3s
- v1.8.9 was synchronous → `afterTurn` always completed before next `assemble()` → no race, clean
- v1.9.0 introduced async ingestion → race introduced
- v1.9.1 added cursor-based tool protocol → race affects tool call classification specifically

### T1: Daemon-flattened assistant tool calls leak through (HIGH)

In v1.9.7, the `findLiveToolSourceInCurrentTurn` function allows `message.role === "assistant"` through (line ~489). The comment says "Daemon flattens structured toolCall blocks into [tool:name] text, which no longer triggers hasKernelToolCallBlock."

When the daemon returns a previous turn's assistant response that contained a tool call, the flattened `[tool:image_gen]` text matches against the source transcript. The function finds the source message, gates 1 or 2 fire, and:
- Gate 1 pushes the original (unsanitized) source message directly
- Gate 2 drops it with `continue`

BUT: Gate 1 pushes **unsanitized** source messages. If the source message contains the full structured tool call JSON block, the model sees the complete tool call syntax and re-executes it.

**T1 is gated on T0** — the race determines whether the source transcript is in a state where this match occurs.

### T2: consumeLiveToolAtCursor pushes message that provider replay also matches (MEDIUM)

Gate 1 pushes via `preserveLiveToolProtocolMessage` and advances `liveSourceCursor`. But if the SAME message appears again in the daemon's output (e.g., daemon returns it twice — once from session_raw, once from session_summary), the second occurrence won't match gate 1 (cursor advanced past it) but COULD fall through to gate 3 (provider replay) and get pushed again.

The `pushProviderReplayMessage` dedup should catch this, but only if the sanitized content matches exactly. If the source message and daemon message have different formats, the keys won't match.

**T2 is gated on T0** — the transcript state affects whether daemon returns duplicate entries.

## Comparison: lossless-claw Tool Dedup Approach

The `lossless-claw` plugin (in `/tmp/lossless-claw`) implements a more robust approach to tool call deduplication that our plugin lacks.

### What lossless-claw does differently

**1. Tool-use ID-based dedup** (`filterAssistantToolUseBlocks`, transcript-repair.ts:211-254)
```typescript
function filterAssistantToolUseBlocks(msg, seenToolUseIds, options) {
  for (const block of content) {
    const id = extractToolCallId(rec);
    if (isToolUse && id) {
      if (dropAll || seenToolUseIds.has(id)) {
        dropped.push({ id, reason: dropAll ? "terminal" : "duplicate" });
        continue; // ← drops duplicate tool_use blocks by ID
      }
      if (record) seenToolUseIds.add(id);
    }
    kept.push(block);
  }
}
```
Tracks tool call IDs in a `Set`. If the same `tool_use` block ID appears in a second assistant message, it's dropped immediately. **Our plugin has no tool-ID-based dedup at all** — it relies on content hashing which fails when the same tool call is formatted differently between daemon-flattened and source-message forms.

**2. Tool-result ID-based dedup** (`pushToolResult`, transcript-repair.ts:311-322)
```typescript
const pushToolResult = (msg) => {
  const id = extractToolResultId(msg);
  if (id && seenToolResultIds.has(id)) {
    droppedDuplicateCount += 1; // ← drops duplicate tool results by ID
    return;
  }
  if (id) seenToolResultIds.add(id);
  out.push(msg);
};
```
Duplicated tool results (same `toolCallId`) are dropped. Our plugin pushes tool results as provider replay messages with no tool-ID tracking — the content-based dedup key `${role}\0${content}` doesn't know about tool call IDs at all.

**3. Transcript repair** (`sanitizeToolUseResultPairing`, transcript-repair.ts:286-538)
- Moves `toolResult` messages directly after their matching assistant `tool_use` turn
- Inserts synthetic error `toolResult` for missing tool call IDs
- Drops orphaned `toolResult` messages with no matching `tool_use`
- Drops duplicate `toolResult` messages (same ID)
- Handles error/aborted turns via `dropAll: true, record: false` mode

Our plugin has **no transcript repair at all**. If the daemon returns tool results out of order or orphaned, our plugin passes them through as-is.

**4. Content-hash dedup with ordinal tracking** (`buildMessageContentDuplicateClusters`, assembler.ts:1198-1209)
```typescript
function buildMessageContentDuplicateClusters(items) {
  for (const item of items) {
    const hash = hashText(item.text);
    const existing = clusters.get(hash) ?? [];
    existing.push(item);
    clusters.set(hash, existing);
  }
  return formatDuplicateClusters(clusters, () => "message-content");
}
```
Groups messages by content hash, then reports clusters with >1 item as duplicates. This is diagnostic-only (used for overflow reporting), not active dedup — but it surfaces when the same content appears multiple times.

**5. Replay-ID dedup** (`extractPlainToolReplayTextsById`, engine.ts:521-534)
```typescript
function extractPlainToolReplayTextsById(message) {
  const textsById = new Map();
  const duplicateIds = new Set();
  const addText = (replayId, text) => {
    if (duplicateIds.has(replayId)) return;           // ← already known duplicate
    if (textsById.has(replayId)) {
      textsById.delete(replayId);                     // ← second sighting = duplicate
      duplicateIds.add(replayId);
      return;
    }
    textsById.set(replayId, text);
  };
  // ... extracts tool replay texts keyed by toolCallId
}
```
Tracks replay IDs. First occurrence is stored. Second occurrence marks it as duplicate and removes from output. Third+ occurrences are dropped silently. This is applied during `afterTurn` ingestion to prevent duplicate tool results from being stored.

### Gap analysis: what our plugin is missing

| Capability | lossless-claw | libravdb-memory (ours) | Impact |
|---|---|---|---|
| Tool-use ID dedup | `filterAssistantToolUseBlocks` — `Set<string>` by ID | None — content-based only | Same tool call with different formatting leaks through |
| Tool-result ID dedup | `pushToolResult` — `Set<string>` by ID | None — content-based only | Same tool result appears twice in context |
| Transcript repair | `sanitizeToolUseResultPairing` — reorder, fill gaps, drop orphans | None | Out-of-order tool protocol confuses model |
| Content hash clusters | `buildMessageContentDuplicateClusters` — diagnostic | None | Can't detect when dedup fails |
| Replay-ID dedup | `extractPlainToolReplayTextsById` — at ingest time | None | Duplicate tool results stored in daemon |
| AfterTurn batch dedup | `deduplicateAfterTurnBatch` — tail/suffix match | None | Redundant ingestion of already-stored turns |

### Why this matters for the looping bug

The live tool protocol system (`78da771`) injects source-format tool messages into context without tracking tool call IDs. If the daemon's context replay includes the same tool call message twice (once from `session_raw`, once from `session_summary`), both instances get pushed because:

1. `consumeLiveToolAtCursor` pushes the first instance directly (bypasses dedup)
2. The second instance falls through to provider replay path
3. `pushProviderReplayMessage` checks `${role}\0${content}` — but the daemon-flattened `[tool:image_gen]` format differs from the source-format structured tool call JSON
4. Keys don't match → both are pushed → model sees duplicate tool instruction

Lossless-claw would catch this because `filterAssistantToolUseBlocks` tracks the actual tool call ID, not the text representation.

## Next Steps

1. **Verify T0 (async race)**: Add a debug log at `assemble()` entry showing `sourceMessages.length`, `lastUserIndex`, and whether async ingestion queue has pending items. If duplicated turns correlate with stale transcript length (e.g., missing the last assistant response), T0 is confirmed.

2. **Mitigation — drain async queue before assemble**: In `assemble()`, `await` the session's async ingestion queue before computing cursors. The `FLUSH_ASYNC_INGESTION` Symbol hook already exists. If blocking on ingest adds too much latency, add a short deadline (2s).

3. **Hardening — make cursor computation tolerate stale transcripts**: If the source transcript is incomplete (async ingest pending), `findLiveToolSourceInCurrentTurn` and `consumeLiveToolAtCursor` should treat unconfirmed messages as historical, not live. Currently they treat anything findable after `lastUserIndex` as live.
