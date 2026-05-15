import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type * as fsType from "node:fs";
import type * as grpcType from "@grpc/grpc-js";

import {
  resolveGrpcCredentialMode,
  resolveGrpcCredentials,
  resolveGrpcTarget,
} from "../../src/grpc-client.js";

const require = createRequire(import.meta.url);
const fs = require("fs") as typeof fsType;
const grpc = require("@grpc/grpc-js") as typeof grpcType;

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

test("resolveGrpcCredentials passes key+cert buffers to createSsl", (t) => {
  const certBuffer = Buffer.from("CERT_DATA");
  const keyBuffer = Buffer.from("KEY_DATA");
  const returned = { mocked: true } as unknown as grpcType.ChannelCredentials;

  const readMock = t.mock.method(fs, "readFileSync", (filePath: fsType.PathOrFileDescriptor) => {
    if (filePath === "/certs/client.crt") return certBuffer;
    if (filePath === "/certs/client.key") return keyBuffer;
    throw new Error(`unexpected read: ${String(filePath)}`);
  });
  const createSslMock = t.mock.method(
    grpc.credentials,
    "createSsl",
    () => returned,
  );

  const creds = resolveGrpcCredentials(
    "tcp:192.0.2.10:37421",
    undefined,
    "tls",
    "/certs/client.crt",
    "/certs/client.key",
  );

  assert.equal(creds, returned);
  assert.equal(readMock.mock.callCount(), 2);
  assert.deepEqual(readMock.mock.calls.map((call) => call.arguments[0]), [
    "/certs/client.crt",
    "/certs/client.key",
  ]);
  assert.equal(createSslMock.mock.callCount(), 1);
  assert.deepEqual(createSslMock.mock.calls[0]?.arguments, [
    null,
    keyBuffer,
    certBuffer,
  ]);
});

test("resolveGrpcCredentials passes CA root with key+cert buffers to createSsl", (t) => {
  const caBuffer = Buffer.from("CA_DATA");
  const certBuffer = Buffer.from("CERT_DATA");
  const keyBuffer = Buffer.from("KEY_DATA");
  const returned = { mocked: true } as unknown as grpcType.ChannelCredentials;

  t.mock.method(fs, "readFileSync", (filePath: fsType.PathOrFileDescriptor) => {
    if (filePath === "/certs/ca.pem") return caBuffer;
    if (filePath === "/certs/client.crt") return certBuffer;
    if (filePath === "/certs/client.key") return keyBuffer;
    throw new Error(`unexpected read: ${String(filePath)}`);
  });
  const createSslMock = t.mock.method(
    grpc.credentials,
    "createSsl",
    () => returned,
  );

  const creds = resolveGrpcCredentials(
    "tcp:192.0.2.10:37421",
    "/certs/ca.pem",
    "tls",
    "/certs/client.crt",
    "/certs/client.key",
  );

  assert.equal(creds, returned);
  assert.equal(createSslMock.mock.callCount(), 1);
  assert.deepEqual(createSslMock.mock.calls[0]?.arguments, [
    caBuffer,
    keyBuffer,
    certBuffer,
  ]);
});

test("resolveGrpcCredentials throws when only tlsClientCertPath is set", () => {
  assert.throws(
    () => resolveGrpcCredentials(
      "tcp:192.0.2.10:37421",
      undefined,
      "auto",
      "/path/to/client.crt",
      undefined,
    ),
    /grpcEndpointTlsClientCert and grpcEndpointTlsClientKey must both be set or both be omitted/,
  );
});

test("resolveGrpcCredentials throws when only tlsClientKeyPath is set", () => {
  assert.throws(
    () => resolveGrpcCredentials(
      "tcp:192.0.2.10:37421",
      undefined,
      "auto",
      undefined,
      "/path/to/client.key",
    ),
    /grpcEndpointTlsClientCert and grpcEndpointTlsClientKey must both be set or both be omitted/,
  );
});

test("resolveGrpcCredentials throws ENOENT when client cert file does not exist", (t) => {
  t.mock.method(fs, "readFileSync", (filePath: fsType.PathOrFileDescriptor) => {
    throw new Error(`ENOENT: no such file or directory, open '${String(filePath)}'`);
  });

  assert.throws(
    () => resolveGrpcCredentials(
      "tcp:192.0.2.10:37421",
      undefined,
      "auto",
      "/nonexistent/client.crt",
      "/certs/client.key",
    ),
    /LibraVDB: failed to load TLS client certificate from "\/nonexistent\/client.crt": ENOENT/,
  );
});

test("resolveGrpcCredentials throws ENOENT when client key file does not exist", (t) => {
  const certBuffer = Buffer.from("CERT_DATA");
  t.mock.method(fs, "readFileSync", (filePath: fsType.PathOrFileDescriptor) => {
    if (filePath === "/certs/client.crt") return certBuffer;
    throw new Error(`ENOENT: no such file or directory, open '${String(filePath)}'`);
  });

  assert.throws(
    () => resolveGrpcCredentials(
      "tcp:192.0.2.10:37421",
      undefined,
      "auto",
      "/certs/client.crt",
      "/nonexistent/client.key",
    ),
    /LibraVDB: failed to load TLS client key from "\/nonexistent\/client.key": ENOENT/,
  );
});

test("resolveGrpcCredentials does NOT read client cert/key files when mode is 'insecure'", (t) => {
  const readMock = t.mock.method(fs, "readFileSync", () => {
    throw new Error("should not read TLS files in insecure mode");
  });
  const creds = resolveGrpcCredentials(
    "tcp:192.0.2.10:37421",
    undefined,
    "insecure",
    "/nonexistent/client.crt",
    "/nonexistent/client.key",
  ) as any;
  assert.equal(creds.secureContext, undefined);
  assert.equal(readMock.mock.callCount(), 0);
});
