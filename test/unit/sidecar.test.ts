import test from "node:test";
import assert from "node:assert/strict";

import {
  daemonProvisioningHint,
  buildSidecarEnv,
  computeBackoffMs,
  defaultEndpoint,
  isTcpEndpoint,
  resolveConfiguredEndpoint,
  resolveEndpoint,
} from "../../src/sidecar.js";

test("resolveEndpoint strips unix prefix and keeps tcp endpoints", () => {
  assert.equal(resolveEndpoint({ rpcTimeoutMs: 1, sidecarPath: "unix:/tmp/x.sock" }), "/tmp/x.sock");
  assert.equal(resolveEndpoint({ rpcTimeoutMs: 1, sidecarPath: "tcp:127.0.0.1:7777" }), "tcp:127.0.0.1:7777");
});

test("resolveConfiguredEndpoint defaults to a stable platform endpoint", () => {
  assert.equal(resolveConfiguredEndpoint({ rpcTimeoutMs: 1 }), defaultEndpoint());
});

test("resolveConfiguredEndpoint rejects executable paths", () => {
  assert.throws(
    () => resolveConfiguredEndpoint({ rpcTimeoutMs: 1, sidecarPath: "/tmp/libravdbd" }),
    /Executable paths are no longer supported/,
  );
});

test("defaultEndpoint uses unix sockets on unix and localhost TCP on windows", () => {
  // On machines where /opt/homebrew/var/clawdb/run/libravdb.sock exists (Homebrew install),
  // defaultEndpoint probes the filesystem and returns the Homebrew path. On machines without
  // it, the user-local fallback (~/.clawdb/run/libravdb.sock) is used. Both are valid unix
  // endpoints — the test verifies the platform dispatch (unix vs win32) and env-var override.
  const darwinResult = defaultEndpoint("darwin", "/Users/demo");
  assert.match(darwinResult, /^unix:.*libravdb\.sock$/);
  assert.equal(defaultEndpoint("win32", "C:\\Users\\demo"), "tcp:127.0.0.1:37421");

  // Env var override takes precedence when set.
  const savedEnv = process.env.LIBRAVDB_RPC_ENDPOINT;
  try {
    process.env.LIBRAVDB_RPC_ENDPOINT = "unix:/custom/path/libravdb.sock";
    assert.equal(defaultEndpoint("darwin", "/Users/demo"), "unix:/custom/path/libravdb.sock");
    process.env.LIBRAVDB_RPC_ENDPOINT = "tcp:10.0.0.1:9999";
    assert.equal(defaultEndpoint("darwin", "/Users/demo"), "tcp:10.0.0.1:9999");
  } finally {
    if (savedEnv === undefined) {
      delete process.env.LIBRAVDB_RPC_ENDPOINT;
    } else {
      process.env.LIBRAVDB_RPC_ENDPOINT = savedEnv;
    }
  }
});

test("computeBackoffMs applies capped exponential backoff", () => {
  assert.equal(computeBackoffMs(0), 500);
  assert.equal(computeBackoffMs(1), 1000);
  assert.equal(computeBackoffMs(10), 16000);
});

test("isTcpEndpoint detects tcp endpoints", () => {
  assert.equal(isTcpEndpoint("tcp:127.0.0.1:7777"), true);
  assert.equal(isTcpEndpoint("/tmp/x.sock"), false);
});

test("buildSidecarEnv maps embedding config into sidecar environment", () => {
  const env = buildSidecarEnv({
    rpcTimeoutMs: 1,
    dbPath: "/tmp/libravdb",
    embeddingRuntimePath: "/opt/onnx/libonnxruntime.so",
    embeddingBackend: "custom-local",
    embeddingProfile: "nomic-embed-text-v1.5",
    fallbackProfile: "all-minilm-l6-v2",
    embeddingModelPath: "/models/custom.onnx",
    embeddingTokenizerPath: "/models/tokenizer.json",
    embeddingDimensions: 768,
    embeddingNormalize: false,
    gatingWeights: { w1c: 0.35, w2c: 0.4, w3c: 0.25, w1t: 0.4, w2t: 0.35, w3t: 0.25 },
    gatingTechNorm: 1.5,
    ingestionGateThreshold: 0.35,
    gatingCentroidK: 10,
    lifecycleJournalMaxEntries: 250,
  });

  assert.deepEqual(env, {
    LIBRAVDB_DB_PATH: "/tmp/libravdb",
    LIBRAVDB_ONNX_RUNTIME: "/opt/onnx/libonnxruntime.so",
    LIBRAVDB_EMBEDDING_BACKEND: "custom-local",
    LIBRAVDB_EMBEDDING_PROFILE: "nomic-embed-text-v1.5",
    LIBRAVDB_FALLBACK_PROFILE: "all-minilm-l6-v2",
    LIBRAVDB_EMBEDDING_MODEL: "/models/custom.onnx",
    LIBRAVDB_EMBEDDING_TOKENIZER: "/models/tokenizer.json",
    LIBRAVDB_EMBEDDING_DIMENSIONS: "768",
    LIBRAVDB_EMBEDDING_NORMALIZE: "false",
    LIBRAVDB_GATING_W1C: "0.35",
    LIBRAVDB_GATING_W2C: "0.4",
    LIBRAVDB_GATING_W3C: "0.25",
    LIBRAVDB_GATING_W1T: "0.4",
    LIBRAVDB_GATING_W2T: "0.35",
    LIBRAVDB_GATING_W3T: "0.25",
    LIBRAVDB_GATING_TECH_NORM: "1.5",
    LIBRAVDB_GATING_THRESHOLD: "0.35",
    LIBRAVDB_GATING_CENTROID_K: "10",
    LIBRAVDB_LIFECYCLE_JOURNAL_MAX_ENTRIES: "250",
  });
});

test("daemonProvisioningHint explains the npm vs Homebrew split", () => {
  assert.match(daemonProvisioningHint(), /npm package/);
  assert.match(daemonProvisioningHint(), /install and start libravdbd separately/);
});
