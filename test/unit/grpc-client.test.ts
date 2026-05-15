import test from "node:test";
import assert from "node:assert/strict";

import { resolveGrpcCredentialMode, resolveGrpcTarget } from "../../src/grpc-client.js";

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
