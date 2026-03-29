import test from "node:test";
import assert from "node:assert/strict";

import { buildSidecarEnv, computeBackoffMs, isTcpEndpoint, resolveEndpoint } from "../../src/sidecar.js";

test("resolveEndpoint strips unix prefix and keeps tcp endpoints", () => {
  assert.equal(resolveEndpoint({ rpcTimeoutMs: 1, sidecarPath: "unix:/tmp/x.sock" }), "/tmp/x.sock");
  assert.equal(resolveEndpoint({ rpcTimeoutMs: 1, sidecarPath: "tcp:127.0.0.1:7777" }), "tcp:127.0.0.1:7777");
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
  });
});
