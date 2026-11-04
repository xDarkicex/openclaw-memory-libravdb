import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { promoteDreamDiaryFile } from "../../src/dream-promotion.js";

const diaryPath = join(process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw"), "admission-dreams.md");
const options = { userId: "tester", diaryPath, text: "## Deep Sleep\n- Keep this {score=0.9 recall=3 unique=2}" };

for (const nodesAccepted of [0, 1]) {
  test(`manual dream promotion rejects explicit admission failure after ${nodesAccepted} accepted nodes`, async () => {
    const client = { async promoteDreamEntries() {
      return { promoted: nodesAccepted, rejected: 0, feedback: { nodesAccepted, nodesRejected: 1 } };
    } };
    await assert.rejects(promoteDreamDiaryFile(client as never, options), /Dream promotion rejected.*nodesRejected=1/);
  });
}

test("dream eligibility rejections and asynchronous queue admission remain successful responses", async () => {
  for (const response of [
    { promoted: 0, rejected: 2 },
    { promoted: 0, rejected: 0, feedback: { nodesAccepted: 0, nodesRejected: 0 } },
    { promoted: 1, rejected: 1, feedback: { nodesAccepted: 1, nodesRejected: 0 } },
  ]) {
    const client = { async promoteDreamEntries() { return response; } };
    assert.deepEqual(await promoteDreamDiaryFile(client as never, options), response);
  }
});
