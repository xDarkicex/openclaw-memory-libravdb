import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDreamPromotionHandle } from "../../src/dream-promotion.js";

class FakeRpcClient {
  calls: Array<{ method: string; params: unknown }> = [];

  async call<T>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "promote_dream_entries") {
      return { promoted: 1, rejected: 0 } as T;
    }
    throw new Error(`unexpected rpc call: ${method}`);
  }
}

class FakeFsApi {
  callbacks = new Map<string, Array<(event: string, filename: string | Buffer | null) => void>>();

  async readFile(file: string) {
    return await fsp.readFile(file);
  }

  async stat(file: string) {
    const stat = await fsp.stat(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  }

  watch(dir: string, onChange: (event: string, filename: string | Buffer | null) => void) {
    const callbacks = this.callbacks.get(dir) ?? [];
    callbacks.push(onChange);
    this.callbacks.set(dir, callbacks);
    return {
      close: () => {
        const next = (this.callbacks.get(dir) ?? []).filter((cb) => cb !== onChange);
        if (next.length > 0) {
          this.callbacks.set(dir, next);
        } else {
          this.callbacks.delete(dir);
        }
      },
      on: () => {},
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("dream promotion handle reads diary bullets and forwards them to the sidecar", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "libravdb-dream-"));
  const diaryPath = path.join(tempRoot, "DREAMS.md");
  await fsp.writeFile(
    diaryPath,
    [
      "# DREAMS",
      "",
      "## Deep Sleep",
      "- Preserve the recent tail buffer {score=0.82 recall=3 unique=2}",
      "- Too weak to promote {score=0.2 recall=1 unique=1}",
    ].join("\n"),
  );

  const rpc = new FakeRpcClient();
  const fsApi = new FakeFsApi();
  const handle = createDreamPromotionHandle(
    {
      dreamPromotionEnabled: true,
      dreamPromotionDiaryPath: diaryPath,
      dreamPromotionUserId: "u1",
      dreamPromotionDebounceMs: 0,
    },
    async () => rpc,
    console,
    fsApi as never,
  );

  await handle.start();
  await delay(25);

  const promoteCall = rpc.calls.find((call) => call.method === "promote_dream_entries");
  assert.ok(promoteCall, "expected dream promotion RPC to fire");
  const params = promoteCall?.params as {
    userId: string;
    sourceDoc: string;
    sourceKind: string;
    entries: Array<{ text: string; score: number; recallCount: number; uniqueQueries: number }>;
  };
  assert.equal(params.userId, "u1");
  assert.equal(params.sourceDoc, diaryPath);
  assert.equal(params.sourceKind, "dream");
  assert.equal(params.entries.length, 2);
  assert.equal(params.entries[0]?.text, "Preserve the recent tail buffer");
  assert.equal(params.entries[1]?.score, 0.2);

  await fsp.writeFile(
    diaryPath,
    [
      "# DREAMS",
      "",
      "## Deep Sleep",
      "- Preserve the recent tail buffer {score=0.82 recall=3 unique=2}",
      "- Too weak to promote {score=0.2 recall=1 unique=1}",
    ].join("\n"),
  );
  fsApi.callbacks.get(path.dirname(diaryPath))?.[0]?.("change", path.basename(diaryPath));
  await delay(25);

  assert.equal(rpc.calls.filter((call) => call.method === "promote_dream_entries").length, 1);

  await handle.stop();
});
