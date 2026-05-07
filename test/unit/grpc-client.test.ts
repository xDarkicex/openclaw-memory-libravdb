import test from "node:test";
import assert from "node:assert/strict";

import { resolveGrpcTarget } from "../../src/grpc-client.js";

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
