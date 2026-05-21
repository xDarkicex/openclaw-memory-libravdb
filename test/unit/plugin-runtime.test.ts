import test from "node:test";
import assert from "node:assert/strict";

import { enrichStartupError, resolveStartupHealthTimeoutMs } from "../../src/plugin-runtime.js";

test("enrichStartupError adds provisioning guidance for daemon startup failures", () => {
  const err = enrichStartupError("LibraVDB daemon failed health check", "embedder running in deterministic fallback mode");
  assert.match(err.message, /daemon failed health check/);
  assert.match(err.message, /deterministic fallback mode/);
  assert.match(err.message, /install and start libravdbd separately/);
});

test("enrichStartupError leaves unrelated errors alone", () => {
  const err = enrichStartupError(new Error("unexpected parser failure"));
  assert.equal(err.message, "unexpected parser failure");
});

test("resolveStartupHealthTimeoutMs uses the normal RPC timeout when it is higher", () => {
  assert.equal(resolveStartupHealthTimeoutMs({}), 30000);
  assert.equal(resolveStartupHealthTimeoutMs({ rpcTimeoutMs: 5000 }), 5000);
  assert.equal(resolveStartupHealthTimeoutMs({ rpcTimeoutMs: 1000 }), 2000);
});
