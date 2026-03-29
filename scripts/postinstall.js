#!/usr/bin/env node

import { chmodSync, cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { buildSidecarReleaseAssetURL, detectSidecarReleaseTarget } from "./sidecar-release.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidecarDir = path.join(root, "sidecar");
const outDir = path.join(root, ".sidecar-bin");
const binary = process.platform === "win32" ? "libravdb-sidecar.exe" : "libravdb-sidecar";
const modelsDir = path.join(root, ".models");
const outModelsDir = path.join(outDir, "models");
const outRuntimeDir = path.join(outDir, "onnxruntime");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

mkdirSync(outDir, { recursive: true });

const installed = await installSidecar(pkg.version);
if (!installed) {
  console.error("[openclaw-memory-libravdb] FATAL: sidecar binary could not be installed.");
  console.error("  1. Check your internet connection (prebuilt download failed)");
  console.error("  2. Or install Go >= 1.22 and retry: https://go.dev/dl/");
  process.exit(1);
}

rmSync(outModelsDir, { recursive: true, force: true });
rmSync(outRuntimeDir, { recursive: true, force: true });
mkdirSync(outModelsDir, { recursive: true });

const bundledMiniLM = path.join(modelsDir, "all-minilm-l6-v2");
if (existsSync(bundledMiniLM)) {
  cpSync(bundledMiniLM, path.join(outModelsDir, "all-minilm-l6-v2"), { recursive: true });
}

const bundledNomic = path.join(modelsDir, "nomic-embed-text-v1.5");
if (existsSync(bundledNomic)) {
  cpSync(bundledNomic, path.join(outModelsDir, "nomic-embed-text-v1.5"), { recursive: true });
}

const runtimeBundle = path.join(modelsDir, "onnxruntime");
if (existsSync(runtimeBundle)) {
  cpSync(runtimeBundle, outRuntimeDir, { recursive: true });
}

async function installSidecar(version) {
  const target = detectSidecarReleaseTarget();
  if (target) {
    const assetUrl = buildSidecarReleaseAssetURL(version, target);
    const checksumUrl = `${assetUrl}.sha256`;
    const downloaded = await tryDownloadPrebuilt(assetUrl, checksumUrl, path.join(outDir, binary));
    if (downloaded) {
      console.log(`[openclaw-memory-libravdb] Sidecar installed (prebuilt ${target})`);
      return true;
    }
    console.warn("[openclaw-memory-libravdb] Prebuilt binary unavailable or failed verification; attempting local go build.");
  } else {
    console.warn(`[openclaw-memory-libravdb] No prebuilt target for ${process.platform}-${process.arch}; attempting local go build.`);
  }

  return tryGoBuild(path.join(outDir, binary));
}

async function tryDownloadPrebuilt(assetUrl, checksumUrl, dest) {
  try {
    const checksum = await fetchChecksum(checksumUrl);
    if (!checksum) {
      return false;
    }
    await downloadToFile(assetUrl, dest);
    const actual = sha256File(dest);
    if (actual !== checksum) {
      rmSync(dest, { force: true });
      console.warn(`[openclaw-memory-libravdb] Prebuilt sidecar checksum mismatch for ${assetUrl}.`);
      return false;
    }
    if (process.platform !== "win32") {
      chmodSync(dest, 0o755);
    }
    return true;
  } catch (error) {
    rmSync(dest, { force: true });
    console.warn(`[openclaw-memory-libravdb] Prebuilt sidecar download failed: ${formatError(error)}`);
    return false;
  }
}

function tryGoBuild(dest) {
  const goCheck = spawnSync("go", ["version"], {
    stdio: "pipe",
    env: process.env,
  });

  if (goCheck.error && goCheck.error.code === "ENOENT") {
    console.error("FATAL: Go toolchain not found on PATH. The LibraVDB sidecar cannot be built locally.");
    return false;
  }

  if (goCheck.status !== 0) {
    console.error("FATAL: Go toolchain check failed. The LibraVDB sidecar cannot be built locally.");
    if (goCheck.stderr?.length) {
      process.stderr.write(goCheck.stderr);
    }
    return false;
  }

  const result = spawnSync("go", ["build", "-o", dest, "."], {
    cwd: sidecarDir,
    stdio: "inherit",
    env: {
      ...process.env,
      GOCACHE: process.env.GOCACHE ?? path.join(os.tmpdir(), "openclaw-memory-libravdb-gocache"),
    },
  });

  if (result.error && result.error.code === "ENOENT") {
    console.error("FATAL: Go toolchain disappeared while building the LibraVDB sidecar.");
    return false;
  }

  if (result.status !== 0) {
    console.error("FATAL: go build failed. The LibraVDB sidecar will not start.");
    return false;
  }

  console.log("[openclaw-memory-libravdb] Sidecar installed (local build)");
  return true;
}

async function fetchChecksum(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const text = (await response.text()).trim();
    const match = text.match(/[a-f0-9]{64}/i);
    return match ? match[0].toLowerCase() : null;
  } catch {
    return null;
  }
}

async function downloadToFile(url, dest) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed: ${url} (${response.status})`);
  }
  const tempPath = `${dest}.tmp`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));
  rmSync(dest, { force: true });
  renameSync(tempPath, dest);
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
