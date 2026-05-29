import test from "node:test";
import assert from "node:assert/strict";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  enrichStartupError,
  resolveStartupHealthTimeoutMs,
  validateEmbeddingConfig,
} from "../../src/plugin-runtime.js";

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
  assert.equal(resolveStartupHealthTimeoutMs({}), 120000);
  assert.equal(resolveStartupHealthTimeoutMs({ rpcTimeoutMs: 5000 }), 5000);
  assert.equal(resolveStartupHealthTimeoutMs({ rpcTimeoutMs: 1000 }), 2000);
});

test("validateEmbeddingConfig rejects onnx-local without explicit daemon asset paths", () => {
  assert.throws(
    () => validateEmbeddingConfig({ embeddingBackend: "onnx-local" }),
    /embeddingBackend="onnx-local" requires embeddingRuntimePath and embeddingModelPath/,
  );
});

test("validateEmbeddingConfig rejects missing local onnx-local model assets", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "libravdb-runtime-test-"));
  try {
    const runtimePath = path.join(tempDir, "libonnxruntime.so");
    writeFileSync(runtimePath, "");

    assert.throws(
      () => validateEmbeddingConfig({
        embeddingBackend: "onnx-local",
        sidecarPath: "unix:/tmp/libravdb.sock",
        embeddingRuntimePath: runtimePath,
        embeddingModelPath: path.join(tempDir, "missing-model"),
      }),
      /embeddingModelPath must point to a directory containing embedding.json/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("validateEmbeddingConfig skips filesystem checks for remote daemon endpoints", () => {
  assert.doesNotThrow(() => validateEmbeddingConfig({
    embeddingBackend: "onnx-local",
    sidecarPath: "tcp:memory.internal:50051",
    embeddingRuntimePath: "/daemon/only/libonnxruntime.so",
    embeddingModelPath: "/daemon/only/nomic-embed-text-v1.5",
  }));
});

test("validateEmbeddingConfig accepts complete local onnx-local asset paths", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "libravdb-runtime-test-"));
  try {
    const runtimePath = path.join(tempDir, "libonnxruntime.so");
    const modelDir = path.join(tempDir, "nomic-embed-text-v1.5");
    writeFileSync(runtimePath, "");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(path.join(modelDir, "embedding.json"), "{}", { flag: "wx" });

    assert.doesNotThrow(() => validateEmbeddingConfig({
      embeddingBackend: "onnx-local",
      sidecarPath: "unix:/tmp/libravdb.sock",
      embeddingRuntimePath: runtimePath,
      embeddingModelPath: modelDir,
    }));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
