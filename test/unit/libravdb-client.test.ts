import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveClientEndpoint,
  createAuthInterceptor,
  LibravDBClient,
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
  try {
    await client.bootstrapHandshake();
  } catch (error) {
    assert.match(
      (error as Error).message,
      /LibraVDB: failed to handshake/,
    );
  }
});

// ---------------------------------------------------------------------------
// Auth interceptor nonce lifecycle
// ---------------------------------------------------------------------------

function state(overrides: Partial<AuthInterceptorState> = {}): AuthInterceptorState {
  return {
    secret: "test-key",
    nonceHex: undefined,
    recovering: false,
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

test("auth skipped for BootstrapSessionKernel", async () => {
  const st = state({ nonceHex: "keep" });
  const int = createAuthInterceptor(st);
  const { sent, header } = headerSink();

  await (int as any)(async () => ({
    header: { get: () => null },
    trailer: { get: () => null },
  }))({ method: { name: "BootstrapSessionKernel" }, header } as any);

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

test("recovery guard blocks concurrent bootstraps", async () => {
  let count = 0;
  let resolveBootstrap!: () => void;
  const bootstrapGate = new Promise<void>((r) => (resolveBootstrap = r));
  const st = state({
    nonceHex: undefined,
    bootstrap: async () => {
      count++;
      await bootstrapGate;
    },
  });
  const int = createAuthInterceptor(st);

  const p1 = (int as any)(async () => ({
    header: { get: () => null },
    trailer: { get: () => null },
  }))({ method: { name: "Status" }, header: { set: () => {} } } as any);

  // Let p1 enter the recovery path and stop at bootstrapGate
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(st.recovering, true);

  // Second call while recovery is still in progress — must not start another bootstrap
  await (int as any)(async () => ({
    header: { get: () => null },
    trailer: { get: () => null },
  }))({ method: { name: "SearchText" }, header: { set: () => {} } } as any);

  resolveBootstrap();
  await p1;

  assert.equal(st.recovering, false);
  assert.equal(count, 1);
});

test("no auth headers without secret", async () => {
  const st = state({ secret: undefined });
  const int = createAuthInterceptor(st);
  const { sent, header } = headerSink();

  await (int as any)(async () => ({
    header: { get: () => null },
    trailer: { get: () => null },
  }))(header as any);

  assert.equal(sent.has("x-libravdb-auth"), false);
});
