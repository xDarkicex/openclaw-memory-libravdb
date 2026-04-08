import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, readFile, writeFile } from "node:fs/promises";

import { buildContextEngineFactory } from "../../src/context-engine.js";
import { createPluginRuntime } from "../../src/plugin-runtime.js";
import { createRecallCache } from "../../src/recall-cache.js";
import { estimateTokens } from "../../src/tokens.js";
import { probeSidecarEndpoint } from "../../src/sidecar.js";
import { acquireTestDaemonHandle } from "./daemon-harness.js";
import type { TestDaemonHandle } from "./daemon-harness.js";
import type { PluginConfig, SearchResult } from "../../src/types.js";

type LongMemEvalTurn = {
  role: string;
  content: string;
  has_answer?: boolean;
};

type LongMemEvalInstance = {
  question_id: string;
  question_type?: string;
  question: string;
  answer?: string;
  question_date?: string | number;
  haystack_session_ids?: string[];
  haystack_dates?: Array<string | number>;
  haystack_sessions?: LongMemEvalTurn[][];
  answer_session_ids?: string[];
};

type BenchmarkRecord = {
  question_id: string;
  question_type: string;
  status: "ok" | "error";
  session_hit: boolean;
  turn_hit: boolean;
  session_prompt_hits: number;
  turn_prompt_hits: number;
  prompt_text: string;
  prompt_chars: number;
  prompt_tokens_estimate: number;
  assembled_message_count: number;
  evidence_turn_count: number;
  evidence_session_ids: string[];
  evidence_snippets: string[];
  raw_user_recovery_candidates?: Array<{
    id: string;
    text: string;
    selected: boolean;
    semanticScore: number;
    lexicalCoverage: number;
    recencyScore: number;
    finalScore: number;
    rationale: string;
  }>;
  error?: string;
};

type BenchmarkStack = {
  daemon: TestDaemonHandle;
  runtime: ReturnType<typeof createPluginRuntime>;
  context: ReturnType<typeof buildContextEngineFactory>;
};

test("LongMemEval local plugin benchmark", async (t) => {
  const dataFile = process.env.LONGMEMEVAL_DATA_FILE?.trim();
  if (!dataFile) {
    t.skip("requires LONGMEMEVAL_DATA_FILE to point at a LongMemEval JSON file");
    return;
  }

  const instances = limitInstances(parseInstances(JSON.parse(await readFile(dataFile, "utf8"))), envLimit());
  const topK = normalizePositiveInteger(process.env.LONGMEMEVAL_TOPK, 8);
  const includeAbstentions = process.env.LONGMEMEVAL_INCLUDE_ABSTENTIONS === "1";
  const outFile = process.env.LONGMEMEVAL_OUT_FILE?.trim() || "";
  const skipped = includeAbstentions ? 0 : instances.filter(isAbstention).length;

  const records: BenchmarkRecord[] = [];
  const useExistingDaemon = process.env.LONGMEMEVAL_USE_EXISTING_DAEMON === "1";
  const cfgBase: Omit<PluginConfig, "sidecarPath"> = {
    rpcTimeoutMs: 30_000,
    topK,
    tokenBudgetFraction: 0.25,
    continuityMinTurns: 1,
    continuityTailBudgetTokens: 1,
    ingestionGateThreshold: 0.35,
  };
  let stack = await createBenchmarkStack(cfgBase, useExistingDaemon);

  try {
    if (outFile) {
      await writeFile(outFile, "", "utf8");
    }

    for (const instance of instances) {
      if (!includeAbstentions && isAbstention(instance)) {
        continue;
      }

      const record = await runWithRetry({
        makeStack: () => createBenchmarkStack(cfgBase, useExistingDaemon),
        currentStack: () => stack,
        replaceStack: (next) => {
          stack = next;
        },
        instance,
        topK,
      });
      records.push(record);
      if (outFile) {
        await appendFile(outFile, `${JSON.stringify(record)}\n`, "utf8");
      }
      console.log(
        `[longmemeval] ${record.question_id} status=${record.status} session_hit=${record.session_hit} turn_hit=${record.turn_hit} session_prompt_hits=${record.session_prompt_hits} turn_prompt_hits=${record.turn_prompt_hits}${record.error ? ` error=${record.error}` : ""}`,
      );
    }
  } finally {
    await stack.runtime.shutdown();
    await stack.daemon.stop();
  }

  const summary = summarizeRecords(records, instances.length);
  console.log(formatSummary(summary, skipped));

  assert.equal(summary.processed > 0, true, "expected at least one benchmark instance to run");
});

async function createBenchmarkStack(cfgBase: Omit<PluginConfig, "sidecarPath">, useExistingDaemon: boolean): Promise<BenchmarkStack> {
  const daemon = useExistingDaemon
    ? await acquireExistingDaemonHandle()
    : await acquireTestDaemonHandle();
  const cfg: PluginConfig = {
    ...cfgBase,
    sidecarPath: daemon.endpoint,
  };
  const runtime = createPluginRuntime(cfg, console);
  const context = buildContextEngineFactory(runtime.getRpc, cfg, createRecallCache<SearchResult>());
  return { daemon, runtime, context };
}

async function runWithRetry({
  makeStack,
  currentStack,
  replaceStack,
  instance,
  topK,
}: {
  makeStack: () => Promise<BenchmarkStack>;
  currentStack: () => BenchmarkStack;
  replaceStack: (stack: BenchmarkStack) => void;
  instance: LongMemEvalInstance;
  topK: number;
}): Promise<BenchmarkRecord> {
  const attempts = 2;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runInstance({
        context: currentStack().context,
        instance,
        topK,
      });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRecoverableBenchmarkError(error)) {
        break;
      }
      const oldStack = currentStack();
      console.warn(`[longmemeval] recoverable failure on ${instance.question_id}; restarting daemon`);
      console.warn(`[longmemeval] previous daemon diagnostics:\n${oldStack.daemon.diagnostics()}`);
      await oldStack.runtime.shutdown().catch(() => {});
      await oldStack.daemon.stop().catch(() => {});
      const nextStack = await makeStack();
      replaceStack(nextStack);
    }
  }

  return errorRecord(instance, lastError);
}

async function runInstance({
  context,
  instance,
  topK,
}: {
  context: ReturnType<typeof buildContextEngineFactory>;
  instance: LongMemEvalInstance;
  topK: number;
}): Promise<BenchmarkRecord> {
  const namespace = sanitizeNamespace(instance.question_id);
  const userId = `longmemeval:${namespace}`;
  const sessionIds = resolveSessionIds(instance, namespace);
  const history = resolveHistory(instance, sessionIds);
  const evidenceSessionIds = resolveEvidenceSessionIds(instance, history);

  for (const session of history) {
    await context.bootstrap({ sessionId: session.sessionId, userId });
    for (const turn of session.turns) {
      await context.ingest({
        sessionId: session.sessionId,
        userId,
        message: { role: turn.role, content: turn.content },
        isHeartbeat: false,
      });
      await delay(10);
    }
  }

  const querySessionId = `${namespace}:query`;
  await context.bootstrap({ sessionId: querySessionId, userId });
  const assembled = await context.assemble({
    sessionId: querySessionId,
    userId,
    messages: [{ role: "user", content: instance.question }],
    tokenBudget: 4000,
  });

  const assembledText = [
    assembled.systemPromptAddition,
    ...assembled.messages.map((message) => message.content),
  ].join("\n");
  const promptText = assembled.systemPromptAddition;
  const promptChars = promptText.length;
  const promptTokensEstimate = estimateTokens(promptText);

  const escapedEvidenceTurns = collectEvidenceTurns(instance, history)
    .map((turn) => escapeXmlText(turn.content))
    .filter((text) => text.length > 0);
  const escapedTurnHits = collectTurnEvidenceTurns(instance, history)
    .map((turn) => escapeXmlText(turn.content))
    .filter((text) => text.length > 0);
  const evidenceSnippets = collectEvidenceTurns(instance, history)
    .map((turn) => snippet(turn.content, 220))
    .filter((text) => text.length > 0);

  const sessionPromptHits = escapedEvidenceTurns.filter((text) => assembledText.includes(text)).length;
  const turnPromptHits = escapedTurnHits.filter((text) => assembledText.includes(text)).length;

  return {
    question_id: instance.question_id,
    question_type: instance.question_type ?? "unknown",
    status: "ok",
    session_hit: sessionPromptHits > 0,
    turn_hit: turnPromptHits > 0,
    session_prompt_hits: sessionPromptHits,
    turn_prompt_hits: turnPromptHits,
    prompt_text: promptText,
    prompt_chars: promptChars,
    prompt_tokens_estimate: promptTokensEstimate,
    assembled_message_count: assembled.messages.length,
    evidence_turn_count: escapedEvidenceTurns.length,
    evidence_session_ids: [...evidenceSessionIds].sort(),
    evidence_snippets: evidenceSnippets,
    raw_user_recovery_candidates: assembled._debug?.rawUserRecoveryCandidates,
  };
}

function errorRecord(instance: LongMemEvalInstance, error: unknown): BenchmarkRecord {
  return {
    question_id: instance.question_id,
    question_type: instance.question_type ?? "unknown",
    status: "error",
    session_hit: false,
    turn_hit: false,
    session_prompt_hits: 0,
    turn_prompt_hits: 0,
    prompt_text: "",
    prompt_chars: 0,
    prompt_tokens_estimate: 0,
    assembled_message_count: 0,
    evidence_turn_count: 0,
    evidence_session_ids: [],
    evidence_snippets: [],
    raw_user_recovery_candidates: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

function summarizeRecords(records: BenchmarkRecord[], total: number) {
  const processed = records.length;
  const sessionHits = records.filter((record) => record.session_hit).length;
  const turnHits = records.filter((record) => record.turn_hit).length;
  const errors = records.filter((record) => record.status === "error").length;
  const promptTokens = records.map((record) => record.prompt_tokens_estimate).filter((value) => Number.isFinite(value));
  const avgPromptTokens = promptTokens.length > 0
    ? promptTokens.reduce((sum, value) => sum + value, 0) / promptTokens.length
    : 0;
  return {
    total,
    processed,
    errors,
    sessionRecallAtK: processed > 0 ? sessionHits / processed : 0,
    turnRecallAtK: processed > 0 ? turnHits / processed : 0,
    avgPromptTokens,
  };
}

function formatSummary(summary: {
  total: number;
  processed: number;
  errors: number;
  sessionRecallAtK: number;
  turnRecallAtK: number;
  avgPromptTokens: number;
}, skippedAbstentions: number): string {
  const rows = [
    ["total questions", String(summary.total)],
    ["processed", String(summary.processed)],
    ["skipped abstentions", String(skippedAbstentions)],
    ["errors", String(summary.errors)],
    ["session hit rate", `${(summary.sessionRecallAtK * 100).toFixed(2)}%`],
    ["turn hit rate", `${(summary.turnRecallAtK * 100).toFixed(2)}%`],
    ["avg prompt tokens", summary.avgPromptTokens.toFixed(1)],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return [
    "LongMemEval local plugin benchmark",
    ...rows.map(([label, value]) => `  ${label.padEnd(width)} : ${value}`),
  ].join("\n");
}

function parseInstances(raw: unknown): LongMemEvalInstance[] {
  if (Array.isArray(raw)) {
    return raw.filter(isLongMemEvalInstance);
  }

  const candidates: unknown[] = raw && typeof raw === "object"
    ? [
        (raw as { data?: unknown }).data,
        (raw as { instances?: unknown }).instances,
        (raw as { questions?: unknown }).questions,
        (raw as { items?: unknown }).items,
      ]
    : [];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isLongMemEvalInstance);
    }
  }

  throw new Error("LongMemEval data file must contain an array of benchmark instances");
}

function isLongMemEvalInstance(value: unknown): value is LongMemEvalInstance {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<LongMemEvalInstance>;
  return typeof candidate.question_id === "string" && typeof candidate.question === "string";
}

function limitInstances(instances: LongMemEvalInstance[], limit: number | null): LongMemEvalInstance[] {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return instances;
  }
  return instances.slice(0, Math.floor(limit));
}

function envLimit(): number | null {
  const raw = process.env.LONGMEMEVAL_LIMIT?.trim();
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizePositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function resolveSessionIds(instance: LongMemEvalInstance, namespace: string): string[] {
  const provided = instance.haystack_session_ids ?? [];
  const sessionCount = instance.haystack_sessions?.length ?? provided.length;
  const ids: string[] = [];
  for (let i = 0; i < Math.max(sessionCount, provided.length); i += 1) {
    const candidate = provided[i]?.trim();
    ids.push(candidate && candidate.length > 0 ? candidate : `${namespace}:session:${i + 1}`);
  }
  return ids;
}

function resolveHistory(instance: LongMemEvalInstance, sessionIds: string[]): Array<{ sessionId: string; turns: LongMemEvalTurn[] }> {
  const sessions = instance.haystack_sessions ?? [];
  return sessions.map((turns, index) => ({
    sessionId: sessionIds[index] ?? `${sanitizeNamespace(instance.question_id)}:session:${index + 1}`,
    turns: turns.map((turn) => ({
      role: typeof turn.role === "string" ? turn.role : "unknown",
      content: typeof turn.content === "string" ? turn.content : "",
      has_answer: turn.has_answer === true,
    })),
  }));
}

function resolveEvidenceSessionIds(
  instance: LongMemEvalInstance,
  history: Array<{ sessionId: string; turns: LongMemEvalTurn[] }>,
): Set<string> {
  const ids = new Set<string>();
  for (const sessionId of instance.answer_session_ids ?? []) {
    const trimmed = sessionId.trim();
    if (trimmed) {
      ids.add(trimmed);
    }
  }
  for (const session of history) {
    if (session.turns.some((turn) => turn.has_answer === true)) {
      ids.add(session.sessionId);
    }
  }
  return ids;
}

function collectEvidenceTurns(
  instance: LongMemEvalInstance,
  history: Array<{ sessionId: string; turns: LongMemEvalTurn[] }>,
): LongMemEvalTurn[] {
  const evidenceSessionIds = resolveEvidenceSessionIds(instance, history);
  return history.flatMap((session) =>
    evidenceSessionIds.has(session.sessionId)
      ? session.turns
      : [],
  );
}

function collectTurnEvidenceTurns(
  _instance: LongMemEvalInstance,
  history: Array<{ sessionId: string; turns: LongMemEvalTurn[] }>,
): LongMemEvalTurn[] {
  return history.flatMap((session) => session.turns.filter((turn) => turn.has_answer === true));
}

function isAbstention(instance: LongMemEvalInstance): boolean {
  return /_abs$/i.test(instance.question_id) || instance.question_type === "abstention";
}

function isRecoverableBenchmarkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Socket closed|RPC timeout|daemon unavailable|sidecar reconnect failed|ECONNRESET|ECONNREFUSED|ENOENT/i.test(message);
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function acquireExistingDaemonHandle() {
  const configured = process.env.LONGMEMEVAL_SIDECAR_PATH?.trim()
    || process.env.LIBRAVDB_TEST_SIDECAR_PATH?.trim()
    || "";
  if (!configured) {
    throw new Error(
      "LONGMEMEVAL_USE_EXISTING_DAEMON=1 requires LONGMEMEVAL_SIDECAR_PATH or LIBRAVDB_TEST_SIDECAR_PATH to point at an already-running libravdbd endpoint",
    );
  }
  const reachable = await probeSidecarEndpoint({
    rpcTimeoutMs: 500,
    sidecarPath: configured,
  });
  if (!reachable) {
    throw new Error(`configured daemon endpoint ${configured} is not reachable`);
  }
  return {
    endpoint: reachable,
    diagnostics() {
      return "existing daemon handle";
    },
    async stop() {},
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snippet(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
}

function sanitizeNamespace(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "unknown";
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
