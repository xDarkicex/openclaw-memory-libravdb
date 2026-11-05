import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { PromoteDreamEntriesRequest } from "@xdarkicex/libravdb-contracts";
import { promoteDreamDiaryFile } from "../../src/dream-promotion.js";
import type { LibravDBClient } from "../../src/libravdb-client.js";

for (const field of ["recall", "unique"]) {
  test(`an out-of-range ${field} count does not prevent valid diary entries from reaching the wire`, async () => {
    let decoded: PromoteDreamEntriesRequest | undefined;
    const client = {
      async promoteDreamEntries(params: Parameters<LibravDBClient["promoteDreamEntries"]>[0]) {
        // Exercise the actual transport encoding: int32 overflow rejects the
        // entire request, even when other entries contain ordinary valid data.
        decoded = PromoteDreamEntriesRequest.fromBinary(new PromoteDreamEntriesRequest(params).toBinary());
        return { promoted: decoded.entries.length };
      },
    } as unknown as LibravDBClient;
    const text = [
      "## Deep Sleep",
      "- ordinary valid entry {score=0.9 recall=3 unique=2}",
      ...[2147483648, -2147483649, Number.MAX_SAFE_INTEGER].map(count =>
        `- invalid count ${count} {score=0.9 recall=${field === "recall" ? count : 3} unique=${field === "unique" ? count : 2}}`),
      "- maximum valid counts {score=0.9 recall=2147483647 unique=2147483647}",
      "- zero counts {score=0.9 recall=0 unique=0}",
    ].join("\n");
    const result = await promoteDreamDiaryFile(client, {
      userId: "tester", diaryPath: path.join(os.homedir(), "dream-counts-test", "DREAMS.md"), text,
    });
    assert.equal(result.promoted, 3);
    assert.deepEqual(decoded?.entries.map(entry => entry.text), ["ordinary valid entry", "maximum valid counts", "zero counts"]);
    assert.equal(decoded?.entries[1]?.recallCount, 2147483647);
    assert.equal(decoded?.entries[1]?.uniqueQueries, 2147483647);
    assert.equal(decoded?.entries[2]?.recallCount, 0);
    assert.equal(decoded?.entries[2]?.uniqueQueries, 0);
  });
}
