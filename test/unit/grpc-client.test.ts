import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveGrpcCredentialMode,
  resolveGrpcCredentials,
  resolveGrpcTarget,
} from "../../src/grpc-client.js";

test("resolveGrpcTarget strips tcp prefix for grpc-js host targets", () => {
  assert.equal(resolveGrpcTarget("tcp:127.0.0.1:37421"), "127.0.0.1:37421");
});

test("resolveGrpcTarget preserves unix scheme for grpc-js UDS resolver", () => {
  assert.equal(
    resolveGrpcTarget("unix:/home/user/.clawdb/run/libravdb.sock"),
    "unix:/home/user/.clawdb/run/libravdb.sock",
  );
});

test("resolveGrpcTarget leaves ordinary grpc targets unchanged", () => {
  assert.equal(resolveGrpcTarget("localhost:37421"), "localhost:37421");
});

test("resolveGrpcCredentialMode keeps local daemon transports insecure", () => {
  assert.equal(resolveGrpcCredentialMode("unix:/home/user/.clawdb/run/libravdb.sock"), "insecure");
  assert.equal(resolveGrpcCredentialMode("tcp:127.0.0.1:37421"), "insecure");
  assert.equal(resolveGrpcCredentialMode("tcp:localhost:37421"), "insecure");
  assert.equal(resolveGrpcCredentialMode("[::1]:37421"), "insecure");
});

test("resolveGrpcCredentialMode uses TLS for non-local grpc targets", () => {
  assert.equal(resolveGrpcCredentialMode("tcp:192.0.2.10:37421"), "tls");
  assert.equal(resolveGrpcCredentialMode("libravdb.example.com:443"), "tls");
  assert.equal(resolveGrpcCredentialMode("dns:///libravdb.example.com:443"), "tls");
});

test("resolveGrpcCredentialMode tlsMode 'tls' overrides address heuristic", () => {
  assert.equal(resolveGrpcCredentialMode("tcp:127.0.0.1:37421", "tls"), "tls");
  assert.equal(resolveGrpcCredentialMode("unix:/home/user/.clawdb/run/libravdb.sock", "tls"), "tls");
});

test("resolveGrpcCredentialMode tlsMode 'insecure' overrides address heuristic", () => {
  assert.equal(resolveGrpcCredentialMode("tcp:192.0.2.10:37421", "insecure"), "insecure");
  assert.equal(resolveGrpcCredentialMode("libravdb.example.com:443", "insecure"), "insecure");
});

test("resolveGrpcCredentialMode tlsMode 'auto' uses address heuristic", () => {
  assert.equal(resolveGrpcCredentialMode("tcp:127.0.0.1:37421", "auto"), "insecure");
  assert.equal(resolveGrpcCredentialMode("tcp:192.0.2.10:37421", "auto"), "tls");
});

test("resolveGrpcCredentialMode undefined tlsMode defaults to auto (heuristic)", () => {
  assert.equal(resolveGrpcCredentialMode("tcp:127.0.0.1:37421", undefined), "insecure");
  assert.equal(resolveGrpcCredentialMode("tcp:192.0.2.10:37421", undefined), "tls");
});

test("resolveGrpcCredentials returns insecure credentials for loopback targets", () => {
  // grpc.ChannelCredentials is typed as opaque; .secureContext is runtime-private.
  // We access it directly in tests to verify credential type without a live connection.
  const creds = resolveGrpcCredentials("tcp:127.0.0.1:37421", undefined, "auto") as any;
  assert.equal(creds.secureContext, undefined);
});

test("resolveGrpcCredentials returns secure credentials for remote targets", () => {
  // Access .secureContext via any to verify TLS — ChannelCredentials is opaque to consumers
  const creds = resolveGrpcCredentials("tcp:192.0.2.10:37421", undefined, "auto") as any;
  assert.notEqual(creds.secureContext, undefined);
});

test("resolveGrpcCredentials throws when CA PEM file path does not exist", () => {
  assert.throws(
    () => resolveGrpcCredentials("tcp:192.0.2.10:37421", "/nonexistent/ca.pem", "auto"),
    /LibraVDB: failed to load TLS CA certificate/,
  );
});

test("resolveGrpcCredentials tlsMode 'insecure' returns insecure credentials regardless of address", () => {
  // Access .secureContext via any to verify plaintext — ChannelCredentials is opaque to consumers
  const creds = resolveGrpcCredentials("tcp:192.0.2.10:37421", undefined, "insecure") as any;
  assert.equal(creds.secureContext, undefined);
});

test("resolveGrpcCredentials tlsMode 'tls' forces secure credentials on loopback", () => {
  // Access .secureContext via any to verify TLS — ChannelCredentials is opaque to consumers
  const creds = resolveGrpcCredentials("tcp:127.0.0.1:37421", undefined, "tls") as any;
  assert.notEqual(creds.secureContext, undefined);
});
