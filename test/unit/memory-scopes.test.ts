import test from "node:test";
import assert from "node:assert/strict";

import { resolveDurableNamespace } from "../../src/memory-scopes.js";

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
