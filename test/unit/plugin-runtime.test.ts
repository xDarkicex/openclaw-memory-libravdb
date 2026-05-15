import test from "node:test";
import assert from "node:assert/strict";

import {
  enrichStartupError,
  resolveStartupHealthTimeoutMs,
  validateGrpcKernelConfig,
} from "../../src/plugin-runtime.js";

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

test("invalid grpcEndpointTlsMode throws with the bad value", () => {
  assert.throws(
    () => validateGrpcKernelConfig({
      grpcEndpoint: "tcp:127.0.0.1:50051",
      grpcEndpointTlsMode: "mtls" as any,
    }, console),
    /invalid grpcEndpointTlsMode.*mtls/,
  );
});

test("omitted grpcEndpointTlsMode is valid for auto credential selection", () => {
  assert.doesNotThrow(() => validateGrpcKernelConfig({
    grpcEndpoint: "tcp:127.0.0.1:50051",
  }, console));
});

test("insecure mode with tlsCaPath logs warning about CA not being used", () => {
  const warnings: string[] = [];
  const logger = {
    error() {},
    warn(message: string) {
      warnings.push(message);
    },
  };
  validateGrpcKernelConfig({
    grpcEndpoint: "tcp:127.0.0.1:50051",
    grpcEndpointTlsMode: "insecure",
    grpcEndpointTlsCa: "/etc/certs/ca.pem",
  }, logger);
  assert.equal(warnings.length, 1, "should have logged one CA/insecure warning");
  assert.match(warnings[0], /grpcEndpointTlsCa/);
  assert.match(warnings[0], /insecure/);
});
