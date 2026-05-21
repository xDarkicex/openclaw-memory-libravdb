import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  resolveClientEndpoint,
  createAuthInterceptor,
  LibravDBClient,
  loadSecretFromEnv,
} from "../../src/libravdb-client.js";

import type { AuthInterceptorState } from "../../src/libravdb-client.js";

// ---------------------------------------------------------------------------
// resolveClientEndpoint
// ---------------------------------------------------------------------------

test("resolveClientEndpoint returns explicit endpoint unchanged", () => {
  assert.equal(resolveClientEndpoint("tcp:10.0.0.1:37421"), "tcp:10.0.0.1:37421");
  assert.equal(resolveClientEndpoint("unix:/custom/path/sock"), "unix:/custom/path/sock");
});

test("resolveClientEndpoint returns env var when endpoint is undefined or auto", () => {
  const prev = process.env.LIBRAVDB_GRPC_ENDPOINT;
  try {
    process.env.LIBRAVDB_GRPC_ENDPOINT = "tcp:env-host:9999";
    assert.equal(resolveClientEndpoint(undefined), "tcp:env-host:9999");
    assert.equal(resolveClientEndpoint("auto"), "tcp:env-host:9999");
  } finally {
    if (prev !== undefined) process.env.LIBRAVDB_GRPC_ENDPOINT = prev;
    else delete process.env.LIBRAVDB_GRPC_ENDPOINT;
  }
});

test("resolveClientEndpoint returns a unix socket path by default on darwin", () => {
  assert.ok(resolveClientEndpoint().startsWith("unix:"));
});

test("loadSecretFromEnv trims direct secrets", () => {
  const savedSecret = process.env.LIBRAVDB_AUTH_SECRET;
  const savedSecretFile = process.env.LIBRAVDB_AUTH_SECRET_FILE;
  try {
    process.env.LIBRAVDB_AUTH_SECRET = "  direct-secret  ";
    process.env.LIBRAVDB_AUTH_SECRET_FILE = "/should/not/be/read";

    assert.equal(loadSecretFromEnv(), "direct-secret");
  } finally {
    if (savedSecret === undefined) {
      delete process.env.LIBRAVDB_AUTH_SECRET;
    } else {
      process.env.LIBRAVDB_AUTH_SECRET = savedSecret;
    }
    if (savedSecretFile === undefined) {
      delete process.env.LIBRAVDB_AUTH_SECRET_FILE;
    } else {
      process.env.LIBRAVDB_AUTH_SECRET_FILE = savedSecretFile;
    }
  }
});

test("loadSecretFromEnv treats whitespace direct secrets as unset and falls back to secret file", () => {
  const savedSecret = process.env.LIBRAVDB_AUTH_SECRET;
  const savedSecretFile = process.env.LIBRAVDB_AUTH_SECRET_FILE;
  const dir = mkdtempSync(path.join(tmpdir(), "libravdb-secret-"));
  try {
    const secretFile = path.join(dir, "secret.txt");
    writeFileSync(secretFile, "  file-secret  \n");
    process.env.LIBRAVDB_AUTH_SECRET = "   ";
    process.env.LIBRAVDB_AUTH_SECRET_FILE = secretFile;

    assert.equal(loadSecretFromEnv(), "file-secret");
  } finally {
    if (savedSecret === undefined) {
      delete process.env.LIBRAVDB_AUTH_SECRET;
    } else {
      process.env.LIBRAVDB_AUTH_SECRET = savedSecret;
    }
    if (savedSecretFile === undefined) {
      delete process.env.LIBRAVDB_AUTH_SECRET_FILE;
    } else {
      process.env.LIBRAVDB_AUTH_SECRET_FILE = savedSecretFile;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSecretFromEnv ignores whitespace direct secrets without file fallback", () => {
  const savedSecret = process.env.LIBRAVDB_AUTH_SECRET;
  const savedSecretFile = process.env.LIBRAVDB_AUTH_SECRET_FILE;
  try {
    process.env.LIBRAVDB_AUTH_SECRET = " \t\n ";
    delete process.env.LIBRAVDB_AUTH_SECRET_FILE;

    assert.equal(loadSecretFromEnv(), undefined);
  } finally {
    if (savedSecret === undefined) {
      delete process.env.LIBRAVDB_AUTH_SECRET;
    } else {
      process.env.LIBRAVDB_AUTH_SECRET = savedSecret;
    }
    if (savedSecretFile === undefined) {
      delete process.env.LIBRAVDB_AUTH_SECRET_FILE;
    } else {
      process.env.LIBRAVDB_AUTH_SECRET_FILE = savedSecretFile;
    }
  }
});

// ---------------------------------------------------------------------------
// Client lifecycle
// ---------------------------------------------------------------------------

test("close prevents RPC methods", async () => {
  const client = new LibravDBClient({ secret: "test" });
  client.close();
  await assert.rejects(client.health({}), /client is closed/);
  await assert.rejects(client.status({}), /client is closed/);
  await assert.rejects(client.bootstrapHandshake(), /client is closed/);
});

test("bootstrapHandshake wraps transport errors", async () => {
  const client = new LibravDBClient({ secret: "test" });
  await assert.rejects(client.bootstrapHandshake(), /LibraVDB: failed to handshake/);
});

// ---------------------------------------------------------------------------
// Auth interceptor nonce lifecycle
// ---------------------------------------------------------------------------

function state(overrides: Partial<AuthInterceptorState> = {}): AuthInterceptorState {
  return {
    secret: "test-key",
    nonceHex: undefined,
    bootstrap: async () => {},
    rpcMutex: {
      current: Promise.resolve(),
      async lock() {
        let release!: () => void;
        const p = new Promise<void>((r) => (release = r));
        const prev = this.current;
        this.current = prev.then(() => p);
        await prev;
        return release;
      },
    },
    ...overrides,
  };
}

function headerSink() {
  const sent = new Map<string, string>();
  return {
    sent,
    header: { set(n: string, v: string) { sent.set(n, v); } },
  };
}

test("nonce sent in request, rotated from response header", async () => {
  const st = state({ nonceHex: "n1" });
  const int = createAuthInterceptor(st);
  const { sent, header } = headerSink();

  await (int as any)(async () => ({
    header: { get: (n: string) => n === "x-libravdb-nonce" ? "n2" : null },
    trailer: { get: () => null },
  }))({ method: { name: "Status" }, header } as any);

  assert.equal(sent.get("x-libravdb-nonce"), "n1");
  assert.equal(sent.get("x-libravdb-auth")?.length, 64);
  assert.equal(st.nonceHex, "n2");
});

test("nonce cleared when transport throws", async () => {
  const st = state({ nonceHex: "active" });
  const int = createAuthInterceptor(st);
  const { sent, header } = headerSink();

  await assert.rejects(
    (int as any)(async () => { throw new Error("boom"); })({ method: { name: "Status" }, header } as any),
    /boom/,
  );

  assert.equal(sent.get("x-libravdb-nonce"), "active");
  assert.equal(st.nonceHex, undefined);
});

test("auth skipped for Health", async () => {
  const st = state({ nonceHex: "keep" });
  const int = createAuthInterceptor(st);
  const { sent, header } = headerSink();

  await (int as any)(async () => ({
    header: { get: () => null },
    trailer: { get: () => null },
  }))({ method: { name: "Health" }, header } as any);

  assert.equal(sent.has("x-libravdb-auth"), false);
  assert.equal(st.nonceHex, "keep");
});

test("nonce read from trailer fallback", async () => {
  const st = state({ nonceHex: "pre" });
  const int = createAuthInterceptor(st);

  await (int as any)(async () => ({
    header: { get: () => null },
    trailer: { get: (n: string) => n === "x-libravdb-nonce" ? "trailer" : null },
  }))({ method: { name: "Status" }, header: { set: () => {} } } as any);

  assert.equal(st.nonceHex, "trailer");
});

test("recovery serializes inside mutex — single bootstrap", async () => {
  let count = 0;
  let resolveBootstrap!: () => void;
  let markBootstrapStarted!: () => void;
  const bootstrapGate = new Promise<void>((r) => (resolveBootstrap = r));
  const bootstrapStarted = new Promise<void>((r) => (markBootstrapStarted = r));
  const st = state({
    nonceHex: undefined,
    bootstrap: async () => {
      count++;
      markBootstrapStarted();
      await bootstrapGate;
      st.nonceHex = "recovered";
    },
  });
  const int = createAuthInterceptor(st);

  // Fire two concurrent requests while nonce is undefined.
  // p1 acquires the lock and triggers bootstrap (blocked on gate).
  // p2 queues behind the lock — it does NOT call bootstrap again.
  const nextRes = {
    header: { get: (n: string) => n === "x-libravdb-nonce" ? "after" : null },
    trailer: { get: () => null },
  };
  const p1 = (int as any)(async () => nextRes)({ method: { name: "Status" }, header: { set: () => {} } } as any);

  const p2 = (int as any)(async () => nextRes)({ method: { name: "SearchText" }, header: { set: () => {} } } as any);

  // Wait until p1 has entered bootstrap and is blocked on the gate
  await bootstrapStarted;

  resolveBootstrap();
  await p1;
  await p2;

  assert.equal(count, 1);
});

test("no auth headers without secret", async () => {
  const st = state({ secret: undefined });
  const int = createAuthInterceptor(st);
  const { sent, header } = headerSink();

  await (int as any)(async () => ({
    header: { get: () => null },
    trailer: { get: () => null },
  }))({ method: { name: "Status" }, header } as any);

  assert.equal(sent.has("x-libravdb-auth"), false);
});
