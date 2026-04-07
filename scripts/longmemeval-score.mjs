import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:fs";

function env(name) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : "";
}

async function assertReadable(filePath, label) {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new Error(`${label} is not readable: ${filePath}`);
  }
}

function runPython(cwd, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", args, {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`python3 exited with code=${code} signal=${signal}`));
    });
  });
}

async function main() {
  const evalRepo = env("LONGMEMEVAL_EVAL_REPO");
  const hypothesisFile = env("LONGMEMEVAL_HYPOTHESIS_FILE");
  const dataFile = env("LONGMEMEVAL_DATA_FILE");
  const model = env("LONGMEMEVAL_EVAL_MODEL") || "gpt-4o";

  if (!evalRepo) {
    throw new Error("LONGMEMEVAL_EVAL_REPO must point at a LongMemEval checkout that contains src/evaluation/evaluate_qa.py");
  }
  if (!hypothesisFile) {
    throw new Error("LONGMEMEVAL_HYPOTHESIS_FILE is required and must point at a jsonl file with question_id and hypothesis");
  }
  if (!dataFile) {
    throw new Error("LONGMEMEVAL_DATA_FILE is required and must point at the LongMemEval dataset JSON");
  }

  const evaluator = path.join(evalRepo, "src", "evaluation", "evaluate_qa.py");
  const metrics = path.join(evalRepo, "src", "evaluation", "print_qa_metrics.py");
  const logFile = `${hypothesisFile}.log`;

  await assertReadable(evalRepo, "LONGMEMEVAL_EVAL_REPO");
  await assertReadable(evaluator, "evaluate_qa.py");
  await assertReadable(hypothesisFile, "LONGMEMEVAL_HYPOTHESIS_FILE");
  await assertReadable(dataFile, "LONGMEMEVAL_DATA_FILE");

  console.log(`[longmemeval-score] running official evaluator in ${evalRepo}`);
  await runPython(path.dirname(evaluator), [
    path.basename(evaluator),
    model,
    hypothesisFile,
    dataFile,
  ], {
    OPENAI_API_KEY: env("OPENAI_API_KEY"),
    OPENAI_ORGANIZATION: env("OPENAI_ORGANIZATION"),
  });

  try {
    await assertReadable(logFile, "evaluation log");
    console.log(`[longmemeval-score] printing metrics from ${logFile}`);
    await runPython(path.dirname(metrics), [
      path.basename(metrics),
      model,
      logFile,
      dataFile,
    ]);
  } catch (error) {
    console.warn(`[longmemeval-score] metrics summary skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
