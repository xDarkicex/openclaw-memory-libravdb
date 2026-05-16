import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { enrichStartupError, loadSecretFromEnv, resolveStartupHealthTimeoutMs, validateGrpcKernelConfig } from "../../src/plugin-runtime.js";

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

test("loadSecretFromEnv trims direct secrets and ignores whitespace-only values", () => {
  const previousSecret = process.env.LIBRAVDB_AUTH_SECRET;
  const previousSecretFile = process.env.LIBRAVDB_AUTH_SECRET_FILE;
  try {
    process.env.LIBRAVDB_AUTH_SECRET = "  direct-secret  ";
    delete process.env.LIBRAVDB_AUTH_SECRET_FILE;
    assert.equal(loadSecretFromEnv(), "direct-secret");

    process.env.LIBRAVDB_AUTH_SECRET = "   ";
    assert.equal(loadSecretFromEnv(), undefined);
  } finally {
    restoreEnv("LIBRAVDB_AUTH_SECRET", previousSecret);
    restoreEnv("LIBRAVDB_AUTH_SECRET_FILE", previousSecretFile);
  }
});

test("loadSecretFromEnv falls back to trimmed secret files", () => {
  const previousSecret = process.env.LIBRAVDB_AUTH_SECRET;
  const previousSecretFile = process.env.LIBRAVDB_AUTH_SECRET_FILE;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "libravdb-secret-"));
  const secretPath = path.join(tempRoot, "secret.txt");
  try {
    fs.writeFileSync(secretPath, "\n file-secret \n");
    process.env.LIBRAVDB_AUTH_SECRET = "   ";
    process.env.LIBRAVDB_AUTH_SECRET_FILE = ` ${secretPath} `;
    assert.equal(loadSecretFromEnv(), "file-secret");

    fs.writeFileSync(secretPath, "\n\t  \n");
    assert.equal(loadSecretFromEnv(), undefined);
  } finally {
    restoreEnv("LIBRAVDB_AUTH_SECRET", previousSecret);
    restoreEnv("LIBRAVDB_AUTH_SECRET_FILE", previousSecretFile);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validateGrpcKernelConfig: invalid grpcEndpointTlsMode throws with the bad value", () => {
  assert.throws(
    () => validateGrpcKernelConfig({
      grpcEndpoint: "tcp:127.0.0.1:50051",
      grpcEndpointTlsMode: "mtls" as any,
    }, console),
    /invalid grpcEndpointTlsMode.*mtls/,
  );
});

test("validateGrpcKernelConfig: omitted grpcEndpointTlsMode is valid for auto credential selection", () => {
  assert.doesNotThrow(() => validateGrpcKernelConfig({
    grpcEndpoint: "tcp:127.0.0.1:50051",
  }, console));
});

test("validateGrpcKernelConfig: insecure mode with tlsCaPath logs warning about CA not being used", () => {
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

test("validateGrpcKernelConfig: throws when grpcEndpointTlsClientCert is set but grpcEndpointTlsClientKey is omitted", () => {
  assert.throws(
    () => validateGrpcKernelConfig({
      grpcEndpoint: "tcp:127.0.0.1:50051",
      grpcEndpointTlsClientCert: "/etc/certs/client.crt",
    }, console),
    /grpcEndpointTlsClientCert and grpcEndpointTlsClientKey must both be set or both be omitted/,
  );
});

test("validateGrpcKernelConfig: throws when grpcEndpointTlsClientKey is set but grpcEndpointTlsClientCert is omitted", () => {
  assert.throws(
    () => validateGrpcKernelConfig({
      grpcEndpoint: "tcp:127.0.0.1:50051",
      grpcEndpointTlsClientKey: "/etc/certs/client.key",
    }, console),
    /grpcEndpointTlsClientCert and grpcEndpointTlsClientKey must both be set or both be omitted/,
  );
});

test("validateGrpcKernelConfig: warning fires when grpcEndpointTlsClientCert is set and grpcEndpointTlsMode is 'insecure'", () => {
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
    grpcEndpointTlsClientCert: "/etc/certs/client.crt",
    grpcEndpointTlsClientKey: "/etc/certs/client.key",
  }, logger);
  assert.equal(warnings.length, 1, "should have logged one client cert/insecure warning");
  assert.match(warnings[0], /grpcEndpointTlsClientCert/);
  assert.match(warnings[0], /insecure/);
});

test("validateGrpcKernelConfig: returns early when grpcEndpoint is not set", () => {
  assert.doesNotThrow(() => validateGrpcKernelConfig({
    grpcEndpointTlsMode: "insecure",
    grpcEndpointTlsCa: "/etc/certs/ca.pem",
  }, console));
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
