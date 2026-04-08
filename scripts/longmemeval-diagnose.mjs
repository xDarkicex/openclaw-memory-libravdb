import { readFile } from "node:fs/promises";

function env(name) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : "";
}

function excerpt(value, maxChars = 260) {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
}

function loadJsonl(path) {
  return readFile(path, "utf8").then((text) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
}

function collectAnswerTurns(instance) {
  const sessions = Array.isArray(instance.haystack_sessions) ? instance.haystack_sessions : [];
  const answerTurns = [];
  for (const session of sessions) {
    for (const turn of session) {
      if (turn && turn.has_answer === true && typeof turn.content === "string" && turn.content.trim()) {
        answerTurns.push(turn.content);
      }
    }
  }
  return answerTurns;
}

function classify(row, answerTurns) {
  const promptText = String(row.prompt_text ?? "");
  const exactHits = answerTurns.filter((turn) => promptText.includes(turn));
  if (exactHits.length > 0) {
    return "answer turn present";
  }
  if ((row.evidence_turn_count ?? 0) > 0) {
    return "related evidence present, exact answer turn missing";
  }
  return "no evidence present";
}

function includesAnswerTurn(candidateText, answerTurns) {
  return answerTurns.some((turn) => String(candidateText ?? "").includes(turn));
}

async function main() {
  const dataFile = env("LONGMEMEVAL_DATA_FILE");
  const outFile = env("LONGMEMEVAL_OUT_FILE");
  const limitRaw = env("LONGMEMEVAL_LIMIT");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : null;

  if (!dataFile) {
    throw new Error("LONGMEMEVAL_DATA_FILE is required");
  }
  if (!outFile) {
    throw new Error("LONGMEMEVAL_OUT_FILE is required");
  }

  const [instances, rows] = await Promise.all([
    readFile(dataFile, "utf8").then((text) => JSON.parse(text)),
    loadJsonl(outFile),
  ]);

  const rowById = new Map(rows.map((row) => [row.question_id, row]));
  const sample = Array.isArray(instances) ? instances : [];
  const relevant = (limit && Number.isFinite(limit) && limit > 0 ? sample.slice(0, Math.floor(limit)) : sample)
    .map((instance) => ({ instance, row: rowById.get(instance.question_id) }))
    .filter(({ row }) => row && row.status === "ok" && !row.turn_hit);

  console.log(`LongMemEval miss diagnosis`);
  console.log(`  misses: ${relevant.length}`);

  for (const { instance, row } of relevant) {
    const answerTurns = collectAnswerTurns(instance);
    const exactHits = answerTurns.filter((turn) => String(row.prompt_text ?? "").includes(turn));
    console.log("");
    console.log(`question_id: ${instance.question_id}`);
    console.log(`question_type: ${instance.question_type ?? "unknown"}`);
    console.log(`classification: ${classify(row, answerTurns)}`);
    console.log(`expected answer turn count: ${answerTurns.length}`);
    answerTurns.slice(0, 2).forEach((turn, index) => {
      console.log(`expected[${index + 1}]: ${excerpt(turn, 360)}`);
    });
    if (answerTurns.length > 2) {
      console.log(`expected[more]: ${answerTurns.length - 2} additional turn(s)`);
    }
    console.log(`produced prompt chars: ${row.prompt_chars}`);
    console.log(`produced prompt tokens: ${row.prompt_tokens_estimate}`);
    console.log(`produced prompt excerpt: ${excerpt(row.prompt_text, 500)}`);
    const snippets = Array.isArray(row.evidence_snippets) ? row.evidence_snippets : [];
    snippets.slice(0, 3).forEach((snippet, index) => {
      console.log(`produced evidence[${index + 1}]: ${excerpt(snippet, 260)}`);
    });
    if (snippets.length > 3) {
      console.log(`produced evidence[more]: ${snippets.length - 3} additional snippet(s)`);
    }
    console.log(`exact answer turn hits in prompt: ${exactHits.length}`);
    const recoveryCandidates = Array.isArray(row.raw_user_recovery_candidates) ? row.raw_user_recovery_candidates : [];
    if (recoveryCandidates.length > 0) {
      console.log(`raw user recovery candidates: ${recoveryCandidates.length}`);
      recoveryCandidates.slice(0, 5).forEach((candidate, index) => {
        const expectedMatch = includesAnswerTurn(candidate.text, answerTurns);
        console.log(
          `candidate[${index + 1}]: selected=${candidate.selected} final=${Number(candidate.finalScore ?? 0).toFixed(3)} semantic=${Number(candidate.semanticScore ?? 0).toFixed(3)} lexical=${Number(candidate.lexicalCoverage ?? 0).toFixed(3)} recency=${Number(candidate.recencyScore ?? 0).toFixed(3)} expected_match=${expectedMatch}`,
        );
        console.log(`candidate_text[${index + 1}]: ${excerpt(candidate.text, 260)}`);
        console.log(`candidate_why[${index + 1}]: ${candidate.rationale ?? "n/a"}`);
      });
      if (recoveryCandidates.length > 5) {
        console.log(`candidate[more]: ${recoveryCandidates.length - 5} additional candidate(s)`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
