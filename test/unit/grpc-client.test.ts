import test from "node:test";
import assert from "node:assert/strict";

import { GrpcKernelClient, resolveGrpcTarget } from "../../src/grpc-client.js";

type MetadataProbe = {
  secret?: string;
  nonceHex?: string;
  getMetadata(signed?: boolean): { get(key: string): unknown[] };
};

function createMetadataProbe(secret?: string, nonceHex?: string): MetadataProbe {
  return Object.assign(
    Object.create(GrpcKernelClient.prototype),
    { secret, nonceHex },
  ) as MetadataProbe;
}

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

test("gRPC auth metadata signs the server nonce with the shared secret", () => {
  const client = createMetadataProbe("test-secret", "00112233445566778899aabbccddeeff");

  const metadata = client.getMetadata(true);

  assert.deepEqual(metadata.get("x-libravdb-auth"), [
    "84b7660ccd62a3d5848a05112cd1cff4e753779cb4464c156e0e57d7c9b6cef3",
  ]);
});

test("gRPC auth metadata requires initializeSession nonce before signed calls", () => {
  const client = createMetadataProbe("test-secret");

  assert.throws(
    () => client.getMetadata(true),
    /call initializeSession before authenticated RPCs/,
  );
});
