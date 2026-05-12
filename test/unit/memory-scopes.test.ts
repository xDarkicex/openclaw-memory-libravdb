import test from "node:test";
import assert from "node:assert/strict";

import { resolveDurableNamespace, validateNamespace } from "../../src/memory-scopes.js";

test("resolveDurableNamespace trims inputs and prefers sessionKey over agentId", () => {
  assert.equal(
    resolveDurableNamespace({ userId: "  user-1  ", sessionKey: "session-1", agentId: "agent-1" }),
    "user-1",
  );
  assert.equal(
    resolveDurableNamespace({ sessionKey: "  session-1  ", agentId: "agent-1" }),
    "session-key:session-1",
  );
  assert.equal(
    resolveDurableNamespace({ agentId: "  agent-1  " }),
    "agent-id:agent-1",
  );
});

test("resolveDurableNamespace trims fallback values and rejects blank fallback strings", () => {
  assert.equal(resolveDurableNamespace({ fallback: "  custom-fallback  " }), "custom-fallback");
  assert.equal(resolveDurableNamespace({ fallback: "   " }), "default");
});

test("validateNamespace rejects invalid collection names", () => {
  // Valid names
  assert.equal(validateNamespace("user-1"), "user-1");
  assert.equal(validateNamespace("session-key:abc"), "session-key:abc");
  assert.equal(validateNamespace("agent-id:my-agent"), "agent-id:my-agent");
  assert.equal(validateNamespace("computment@COMPUTMENT#1fb3bb24"), "computment@COMPUTMENT#1fb3bb24");
  assert.equal(validateNamespace("a"), "a");

  // Invalid names
  assert.throws(() => validateNamespace(""), /Invalid collection namespace/);
  assert.throws(() => validateNamespace("../etc/passwd"), /Invalid collection namespace/);
  assert.throws(() => validateNamespace("1starts-with-number"), /Invalid collection namespace/);
  assert.throws(() => validateNamespace("has spaces"), /Invalid collection namespace/);
  assert.throws(() => validateNamespace("has\nnewline"), /Invalid collection namespace/);
});
