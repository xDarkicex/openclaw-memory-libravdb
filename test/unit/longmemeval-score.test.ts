import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scorer = path.join(process.cwd(), "scripts", "longmemeval-score.mjs");
const pythonAvailable = spawnSync("python3", ["--version"]).status === 0;

test("LongMemEval scorer resolves relative inputs before changing the evaluator working directory", {
  skip: !pythonAvailable && "Python is required to run the evaluator fixture",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "libravdb-score-"));
  try {
    const evaluation = path.join(root, "evaluation checkout", "src", "evaluation");
    fs.mkdirSync(evaluation, { recursive: true });
    fs.writeFileSync(path.join(root, "hypotheses.jsonl"), '{"question_id":"q1","hypothesis":"answer"}\n');
    fs.writeFileSync(path.join(root, "dataset.json"), "[]");
    fs.writeFileSync(path.join(evaluation, "evaluate_qa.py"), `
import pathlib, sys
hypothesis = pathlib.Path(sys.argv[2])
assert hypothesis.read_text().startswith('{"question_id"')
assert pathlib.Path(sys.argv[3]).read_text() == "[]"
pathlib.Path(str(hypothesis) + ".log").write_text("scored")
`);
    fs.writeFileSync(path.join(evaluation, "print_qa_metrics.py"), `
import pathlib, sys
assert pathlib.Path(sys.argv[2]).read_text() == "scored"
assert pathlib.Path(sys.argv[3]).read_text() == "[]"
print("fixture metrics printed")
`);
    const result = spawnSync(process.execPath, [scorer], {
      cwd: root,
      env: {
        ...process.env,
        LONGMEMEVAL_EVAL_REPO: "evaluation checkout",
        LONGMEMEVAL_HYPOTHESIS_FILE: "hypotheses.jsonl",
        LONGMEMEVAL_DATA_FILE: "dataset.json",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fixture metrics printed/);
    assert.equal(fs.readFileSync(path.join(root, "hypotheses.jsonl.log"), "utf8"), "scored");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
