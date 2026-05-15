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

test("invalid grpcEndpointTlsMode logs error with the bad value", async () => {
  const errors: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const msg = args.join(" ");
    if (msg.includes("invalid grpcEndpointTlsMode")) errors.push(msg);
  };
  try {
    const { createPluginRuntime } = await import("../../src/plugin-runtime.js");
    const runtime = createPluginRuntime({
      grpcEndpoint: "tcp:127.0.0.1:50051",
      grpcEndpointTlsMode: "mtls" as any,
    });
    // Trigger ensureStarted
    await runtime.getKernel();
    assert.equal(errors.length, 1, "should have logged one invalid grpcEndpointTlsMode error");
    assert.match(errors[0], /mtls/);
  } finally {
    console.warn = origWarn;
  }
});

test("insecure mode with tlsCaPath logs warning about CA not being used", async () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const msg = args.join(" ");
    if (msg.includes("grpcEndpointTlsCa") || msg.includes("insecure")) {
      warnings.push(msg);
    }
  };
  try {
    const { createPluginRuntime } = await import("../../src/plugin-runtime.js");
    const runtime = createPluginRuntime({
      grpcEndpoint: "tcp:127.0.0.1:50051",
      grpcEndpointTlsMode: "insecure",
      grpcEndpointTlsCa: "/etc/certs/ca.pem",
    });
    await runtime.getKernel();
    assert.equal(warnings.length, 1, "should have logged one CA/insecure warning");
    assert.match(warnings[0], /grpcEndpointTlsCa/);
    assert.match(warnings[0], /insecure/);
  } finally {
    console.warn = origWarn;
  }
});
