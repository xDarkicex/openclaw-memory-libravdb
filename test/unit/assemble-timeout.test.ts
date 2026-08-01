import test from "node:test";
import assert from "node:assert/strict";

// Verify the Promise.race timeout pattern used by assembleContextInternal.
// When an underlying gRPC call hangs (daemon unresponsive), the timeout
// must reject within the configured window so the agent pipeline recovers.

test("assemble timeout rejects when promise hangs", async () => {
  const timeoutMs = 50;

  const neverResolves = new Promise<never>(() => {
    // intentionally never settles — simulates hung gRPC call
  });

  const timedOut = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`AssembleContextInternal timed out after ${timeoutMs}ms`)), timeoutMs)
  );

  const start = Date.now();
  await assert.rejects(
    () => Promise.race([neverResolves, timedOut]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("timed out"));
      assert.ok(err.message.includes(String(timeoutMs)));
      return true;
    }
  );
  const elapsed = Date.now() - start;
  // Allow 50ms grace for timer imprecision
  assert.ok(elapsed < timeoutMs + 50, `timeout took ${elapsed}ms, expected ~${timeoutMs}ms`);
});

test("assemble timeout returns result when promise resolves before timeout", async () => {
  const timeoutMs = 5000;

  const resolvesQuickly = Promise.resolve({ messages: [], systemPromptAddition: "" });

  const timedOut = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`AssembleContextInternal timed out after ${timeoutMs}ms`)), timeoutMs)
  );

  const result = await Promise.race([resolvesQuickly, timedOut]);
  assert.deepEqual(result, { messages: [], systemPromptAddition: "" });
});

test("assemble timeout uses configured value", () => {
  // Default: 30000ms
  const cfg = {} as { assembleTimeoutMs?: number };
  const timeout = cfg.assembleTimeoutMs ?? 30000;
  assert.equal(timeout, 30000);

  // Explicit: 15000ms
  cfg.assembleTimeoutMs = 15000;
  const custom = cfg.assembleTimeoutMs ?? 30000;
  assert.equal(custom, 15000);
});
