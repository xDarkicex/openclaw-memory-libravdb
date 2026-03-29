import { createHash } from "node:crypto";
import { createWriteStream, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type AssetSpec = {
  name: string;
  dest: string;
  sha256?: string;
  url?: string;
  optional?: boolean;
  localSource?: string;
};

type RuntimeSpec = {
  archiveName: string;
  url: string;
  archiveSha256?: string;
  archiveChecksumURL?: string;
  extractedLib: string;
  format: "tgz" | "zip";
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidecarDir = path.join(rootDir, "sidecar");
const sidecarBinDir = path.join(rootDir, ".sidecar-bin");
const modelsDir = path.join(sidecarBinDir, "models");
const runtimeDir = path.join(sidecarBinDir, "onnxruntime");
const binaryName = process.platform === "win32" ? "libravdb-sidecar.exe" : "libravdb-sidecar";
const sidecarBinary = path.join(sidecarBinDir, binaryName);

const nomicAssets: AssetSpec[] = [
  {
    name: "nomic-embed-text-v1.5 model",
    dest: path.join(modelsDir, "nomic-embed-text-v1.5", "model.onnx"),
    localSource: path.join(rootDir, ".models", "nomic-embed-text-v1.5", "model.onnx"),
    url: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/onnx/model.onnx",
    sha256: "147d5aa88c2101237358e17796cf3a227cead1ec304ec34b465bb08e9d952965",
  },
  {
    name: "nomic-embed-text-v1.5 tokenizer",
    dest: path.join(modelsDir, "nomic-embed-text-v1.5", "tokenizer.json"),
    localSource: path.join(rootDir, ".models", "nomic-embed-text-v1.5", "tokenizer.json"),
    url: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/tokenizer.json",
    sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
  },
];

const miniLMAssets: AssetSpec[] = [
  {
    name: "all-minilm-l6-v2 model",
    dest: path.join(modelsDir, "all-minilm-l6-v2", "model.onnx"),
    localSource: path.join(rootDir, ".models", "all-minilm-l6-v2", "model.onnx"),
    url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx",
    sha256: "759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e",
  },
  {
    name: "all-minilm-l6-v2 tokenizer",
    dest: path.join(modelsDir, "all-minilm-l6-v2", "tokenizer.json"),
    localSource: path.join(rootDir, ".models", "all-minilm-l6-v2", "tokenizer.json"),
    url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json",
    sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
  },
];

const t5Assets: AssetSpec[] = [
  {
    name: "t5-small encoder",
    dest: path.join(modelsDir, "t5-small", "encoder_model.onnx"),
    localSource: path.join(rootDir, ".models", "t5-small", "encoder_model.onnx"),
    url: "https://huggingface.co/optimum/t5-small/resolve/main/encoder_model.onnx",
    sha256: "41d326633f1b85f526508cc0db78a5d40877c292c1b6dccae2eacd7d2a53480d",
    optional: true,
  },
  {
    name: "t5-small decoder",
    dest: path.join(modelsDir, "t5-small", "decoder_model.onnx"),
    localSource: path.join(rootDir, ".models", "t5-small", "decoder_model.onnx"),
    url: "https://huggingface.co/optimum/t5-small/resolve/main/decoder_model.onnx",
    sha256: "0a1451011d61bcc796a87b7306c503562e910f110f884d0cc08532972c2cc584",
    optional: true,
  },
  {
    name: "t5-small tokenizer",
    dest: path.join(modelsDir, "t5-small", "tokenizer.json"),
    localSource: path.join(rootDir, ".models", "t5-small", "tokenizer.json"),
    url: "https://huggingface.co/optimum/t5-small/resolve/main/tokenizer.json",
    sha256: "5f0ed8ab5b8cfa9812bb73752f1d80c292e52bcf5a87a144dc9ab2d251056cbb",
    optional: true,
  },
  {
    name: "t5-small tokenizer config",
    dest: path.join(modelsDir, "t5-small", "tokenizer_config.json"),
    localSource: path.join(rootDir, ".models", "t5-small", "tokenizer_config.json"),
    url: "https://huggingface.co/optimum/t5-small/resolve/main/tokenizer_config.json",
    sha256: "4969f8d76ef05a16553bd2b07b3501673ae8d36972aea88a0f78ad31a3ff2de9",
    optional: true,
  },
  {
    name: "t5-small config",
    dest: path.join(modelsDir, "t5-small", "config.json"),
    localSource: path.join(rootDir, ".models", "t5-small", "config.json"),
    url: "https://huggingface.co/optimum/t5-small/resolve/main/config.json",
    sha256: "d112428e703aa7ea0d6b17a77e9739fcc15b87653779d9b7942d5ecbc61c00ed",
    optional: true,
  },
];

const runtimeSpecs: Record<string, RuntimeSpec> = {
  "darwin-arm64": {
    archiveName: "onnxruntime-osx-arm64-1.23.0.tgz",
    url: "https://github.com/microsoft/onnxruntime/releases/download/v1.23.0/onnxruntime-osx-arm64-1.23.0.tgz",
    archiveSha256: "8182db0ebb5caa21036a3c78178f17fabb98a7916bdab454467c8f4cf34bcfdf",
    extractedLib: path.join(runtimeDir, "onnxruntime-osx-arm64-1.23.0", "lib", "libonnxruntime.dylib"),
    format: "tgz",
  },
  "linux-x64": {
    archiveName: "onnxruntime-linux-x64-1.23.0.tgz",
    url: "https://github.com/microsoft/onnxruntime/releases/download/v1.23.0/onnxruntime-linux-x64-1.23.0.tgz",
    archiveChecksumURL: "https://github.com/microsoft/onnxruntime/releases/download/v1.23.0/onnxruntime-linux-x64-1.23.0.tgz.sha256",
    extractedLib: path.join(runtimeDir, "onnxruntime-linux-x64-1.23.0", "lib", "libonnxruntime.so"),
    format: "tgz",
  },
  "win32-x64": {
    archiveName: "onnxruntime-win-x64-1.23.0.zip",
    url: "https://github.com/microsoft/onnxruntime/releases/download/v1.23.0/onnxruntime-win-x64-1.23.0.zip",
    archiveChecksumURL: "https://github.com/microsoft/onnxruntime/releases/download/v1.23.0/onnxruntime-win-x64-1.23.0.zip.sha256",
    extractedLib: path.join(runtimeDir, "onnxruntime-win-x64-1.23.0", "lib", "onnxruntime.dll"),
    format: "zip",
  },
};

async function main(): Promise<void> {
  console.log("[openclaw-memory-libravdb] Building Go sidecar...");
  buildSidecar();

  mkdirSync(sidecarBinDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });

  console.log("[openclaw-memory-libravdb] Provisioning embedding model...");
  for (const asset of nomicAssets) {
    await ensureAsset(asset);
  }
  writeEmbeddingManifest();
  for (const asset of miniLMAssets) {
    await ensureAsset(asset);
  }
  writeMiniLMManifest();

  console.log("[openclaw-memory-libravdb] Provisioning ONNX runtime...");
  await ensureRuntime();

  console.log("[openclaw-memory-libravdb] Provisioning summarizer model...");
  await ensureOptionalAssets(t5Assets, writeSummarizerManifest);

  console.log("[openclaw-memory-libravdb] Verifying sidecar health...");
  await verifySidecarHealth();

  console.log("[openclaw-memory-libravdb] Setup complete.");
}

function buildSidecar(): void {
  const result = spawnSync(process.execPath, [path.join(rootDir, "scripts", "postinstall.js")], {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function ensureAsset(spec: AssetSpec): Promise<void> {
  mkdirSync(path.dirname(spec.dest), { recursive: true });

  if (existsSync(spec.dest) && await verifyFile(spec.dest, spec.sha256)) {
    return;
  }

  if (existsSync(spec.dest)) {
    rmSync(spec.dest, { force: true });
  }

  if (spec.localSource && existsSync(spec.localSource) && await verifyFile(spec.localSource, spec.sha256)) {
    cpSync(spec.localSource, spec.dest);
    return;
  }

  if (!spec.url) {
    throw new Error(`No download URL available for required asset: ${spec.name}`);
  }

  await downloadToFile(spec.url, spec.dest);
  if (!await verifyFile(spec.dest, spec.sha256)) {
    rmSync(spec.dest, { force: true });
    throw new Error(`SHA-256 verification failed for ${spec.name}`);
  }
}

async function ensureOptionalAssets(assets: AssetSpec[], onSuccess: () => void): Promise<void> {
  try {
    for (const asset of assets) {
      await ensureAsset(asset);
    }
    onSuccess();
  } catch (error) {
    console.warn(`[openclaw-memory-libravdb] Optional summarizer provisioning skipped: ${(error as Error).message}`);
  }
}

function writeEmbeddingManifest(): void {
  const dir = path.join(modelsDir, "nomic-embed-text-v1.5");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "embedding.json"), `${JSON.stringify({
    backend: "onnx-local",
    profile: "nomic-embed-text-v1.5",
    family: "nomic-embed-text-v1.5",
    model: "model.onnx",
    tokenizer: "tokenizer.json",
    dimensions: 768,
    normalize: true,
    inputNames: ["input_ids", "attention_mask", "token_type_ids"],
    outputName: "last_hidden_state",
    pooling: "mean",
    addSpecialTokens: true,
  }, null, 2)}\n`);
}

function writeMiniLMManifest(): void {
  const dir = path.join(modelsDir, "all-minilm-l6-v2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "embedding.json"), `${JSON.stringify({
    backend: "onnx-local",
    profile: "all-minilm-l6-v2",
    family: "all-minilm-l6-v2",
    model: "model.onnx",
    tokenizer: "tokenizer.json",
    dimensions: 384,
    normalize: true,
    pooling: "mean",
    addSpecialTokens: true,
  }, null, 2)}\n`);
}

function writeSummarizerManifest(): void {
  const dir = path.join(modelsDir, "t5-small");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "summarizer.json"), `${JSON.stringify({
    backend: "onnx-local",
    profile: "t5-small",
    family: "t5-small",
    encoder: "encoder_model.onnx",
    decoder: "decoder_model.onnx",
    tokenizer: "tokenizer.json",
    maxContextTokens: 512,
  }, null, 2)}\n`);
}

async function ensureRuntime(): Promise<void> {
  const spec = runtimeSpecs[`${process.platform}-${process.arch}`];
  if (!spec) {
    throw new Error(`Unsupported runtime platform: ${process.platform}/${process.arch}`);
  }
  if (existsSync(spec.extractedLib)) {
    return;
  }

  mkdirSync(runtimeDir, { recursive: true });
  const archivePath = path.join(runtimeDir, spec.archiveName);
  const localArchive = path.join(rootDir, ".models", "onnxruntime", spec.archiveName);

  if (!(existsSync(archivePath) && await verifyArchive(archivePath, spec))) {
    rmSync(archivePath, { force: true });

    if (existsSync(localArchive) && await verifyArchive(localArchive, spec)) {
      cpSync(localArchive, archivePath);
    } else {
      await downloadToFile(spec.url, archivePath);
      if (!await verifyArchive(archivePath, spec)) {
        rmSync(archivePath, { force: true });
        throw new Error(`SHA-256 verification failed for runtime archive ${spec.archiveName}`);
      }
    }
  }

  await extractRuntimeArchive(spec, archivePath);
  if (!existsSync(spec.extractedLib)) {
    throw new Error(`Runtime archive extracted but library missing: ${spec.extractedLib}`);
  }
}

async function verifyArchive(archivePath: string, spec: RuntimeSpec): Promise<boolean> {
  if (spec.archiveSha256) {
    return await verifyFile(archivePath, spec.archiveSha256);
  }
  if (!spec.archiveChecksumURL) {
    return false;
  }
  const expected = await fetchChecksum(spec.archiveChecksumURL);
  if (!expected) {
    return false;
  }
  return await verifyFile(archivePath, expected);
}

async function fetchChecksum(url: string): Promise<string | null> {
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

async function extractRuntimeArchive(spec: RuntimeSpec, archivePath: string): Promise<void> {
  if (spec.format === "tgz") {
    const result = spawnSync("tar", ["-xzf", archivePath, "-C", runtimeDir], {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(`Failed to extract runtime archive ${spec.archiveName}`);
    }
    return;
  }

  if (process.platform !== "win32") {
    throw new Error(`ZIP runtime extraction is only supported on Windows for ${spec.archiveName}`);
  }

  const result = spawnSync("powershell", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -Path "${archivePath}" -DestinationPath "${runtimeDir}" -Force`,
  ], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Failed to extract runtime archive ${spec.archiveName}`);
  }
}

async function verifySidecarHealth(): Promise<void> {
  if (!existsSync(sidecarBinary)) {
    throw new Error(`Sidecar binary not found after setup: ${sidecarBinary}`);
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-libravdb-setup-"));
  const child = spawn(sidecarBinary, [], {
    cwd: rootDir,
    env: {
      ...process.env,
      LIBRAVDB_DB_PATH: tempDir,
      LIBRAVDB_SUMMARIZER_BACKEND: "bundled",
      LIBRAVDB_SUMMARIZER_PROFILE: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const endpoint = await waitForEndpoint(child);
    const health = await callHealth(endpoint);
    if (!health.ok) {
      throw new Error(`Sidecar health check failed: ${health.message ?? "unknown error"}`);
    }
  } finally {
    child.kill();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function waitForEndpoint(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`Timed out waiting for sidecar endpoint${stderr ? `: ${stderr.trim()}` : ""}`));
    }, 10000);

    const finishResolve = (endpoint: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(endpoint);
    };

    const finishReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => finishReject(error));
    child.once("exit", (code) => {
      finishReject(new Error(
        `Sidecar exited before advertising endpoint (code ${code ?? "unknown"})${stderr ? `: ${stderr.trim()}` : ""}`,
      ));
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const line = chunk.split("\n").map((v) => v.trim()).find(Boolean);
      if (!line) {
        return;
      }
      finishResolve(line);
    });
  });
}

function callHealth(endpoint: string): Promise<{ ok?: boolean; message?: string }> {
  return new Promise((resolve, reject) => {
    const socket = endpoint.startsWith("tcp:")
      ? connectTcp(endpoint)
      : net.createConnection(endpoint);

    let buf = "";
    const cleanup = () => socket.destroy();

    socket.setEncoding("utf8");
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
    socket.on("data", (chunk) => {
      buf += chunk;
      const line = buf.split("\n").find((value) => value.trim());
      if (!line) {
        return;
      }
      cleanup();
      try {
        const msg = JSON.parse(line) as { result?: { ok?: boolean; message?: string }; error?: { message?: string } };
        if (msg.error?.message) {
          reject(new Error(msg.error.message));
          return;
        }
        resolve(msg.result ?? {});
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health", params: {} })}\n`);
    });
  });
}

function connectTcp(endpoint: string): net.Socket {
  const raw = endpoint.slice("tcp:".length);
  const [host, portText] = raw.split(":");
  const port = Number(portText);
  if (!host || !Number.isFinite(port)) {
    throw new Error(`Invalid TCP sidecar endpoint: ${endpoint}`);
  }
  return net.createConnection({ host, port });
}

async function verifyFile(filePath: string, expectedSha256?: string): Promise<boolean> {
  if (!expectedSha256) {
    return existsSync(filePath);
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return false;
  }
  const actual = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  return actual === expectedSha256.toLowerCase();
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${url} (${response.status})`);
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  const tempPath = `${dest}.tmp`;
  await pipeline(Readable.fromWeb(response.body as any), createWriteStream(tempPath));
  rmSync(dest, { force: true });
  renameSync(tempPath, dest);
}

await main();
