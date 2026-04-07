import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { probeSidecarEndpoint } from "../../src/sidecar.js";
import type { PluginConfig } from "../../src/types.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd());
const buildScript = path.join(repoRoot, "scripts", "build-daemon.sh");
const daemonBinary = path.join(repoRoot, ".daemon-bin", process.platform === "win32" ? "libravdbd.exe" : "libravdbd");
const daemonReadyTimeoutMs = 120_000;

export interface TestDaemonHandle {
  endpoint: string;
  diagnostics(): string;
  stop(): Promise<void>;
}

let buildOnce: Promise<void> | null = null;

async function ensureDaemonBuilt(): Promise<void> {
  if (!buildOnce) {
    buildOnce = execFileAsync("bash", [buildScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GOCACHE: process.env.GOCACHE ?? "/tmp/openclaw-go-cache",
      },
      maxBuffer: 16 * 1024 * 1024,
    })
      .then(() => undefined)
      .catch((error) => {
        buildOnce = null;
        throw error;
      });
  }
  await buildOnce;
}

async function waitForLineMatching(readable: NodeJS.ReadableStream, pattern: RegExp): Promise<string> {
  const reader = createInterface({ input: readable });
  return await new Promise<string>((resolve, reject) => {
    reader.on("line", (line) => {
      const trimmed = line.trim();
      if (pattern.test(trimmed)) {
        reader.close();
        resolve(trimmed);
      }
    });
    reader.on("error", (error) => {
      reader.close();
      reject(error);
    });
  });
}

async function waitForReachableEndpoint(endpoint: string, child?: { exitCode: number | null; signalCode: NodeJS.Signals | null }): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < daemonReadyTimeoutMs) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`local libravdbd exited before becoming reachable at ${endpoint}`);
    }
    const reachable = await probeSidecarEndpoint({
      rpcTimeoutMs: 500,
      sidecarPath: endpoint,
    });
    if (reachable) {
      return reachable;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for local libravdbd to become reachable at ${endpoint}`);
}

async function launchDaemonAtEndpoint(endpoint: string, tempDir: string): Promise<TestDaemonHandle> {
  const dbPath = path.join(tempDir, "libravdb-data.libravdb");
  let child: ReturnType<typeof spawn> | null = null;
  let stderr = "";

  try {
    child = spawn(daemonBinary, [], {
      cwd: repoRoot,
      env: {
        ...process.env,
        LIBRAVDB_DB_PATH: dbPath,
        LIBRAVDB_RPC_ENDPOINT: endpoint,
        GOCACHE: process.env.GOCACHE ?? "/tmp/openclaw-go-cache",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }

    const reportedEndpoint = await Promise.race([
      waitForLineMatching(child.stdout!, /^(?:tcp:|unix:)/),
      new Promise<string>((_, reject) => {
        child?.once("exit", (code, signal) => {
          reject(
            new Error(
              `local libravdbd exited before reporting an endpoint (code=${code}, signal=${signal})\n${stderr.trim()}`,
            ),
          );
        });
        child?.once("error", (error) => reject(error));
      }),
    ]);
    const reachable = await waitForReachableEndpoint(reportedEndpoint, child);

    return {
      endpoint: reachable,
      diagnostics() {
        const proc = child;
        const exitLine = proc
          ? `exitCode=${proc.exitCode ?? "null"} signalCode=${proc.signalCode ?? "null"}`
          : "exitCode=null signalCode=null";
        const body = stderr.trim();
        return body ? `${exitLine}\n${body}` : exitLine;
      },
      async stop() {
        const proc = child;
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGTERM");
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              if (proc.exitCode === null && proc.signalCode === null) {
                proc.kill("SIGKILL");
              }
              resolve();
            }, 5_000);
            proc.once("exit", () => {
              clearTimeout(timeout);
              resolve();
            });
          });
        }
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export async function acquireTestDaemonHandle(): Promise<TestDaemonHandle> {
  const configured = process.env.LIBRAVDB_TEST_SIDECAR_PATH?.trim();
  if (configured) {
    const reachable = await probeSidecarEndpoint({
      rpcTimeoutMs: 500,
      sidecarPath: configured,
    });
    if (!reachable) {
      throw new Error(`configured daemon endpoint ${configured} is not reachable`);
    }
    return {
      endpoint: reachable,
      diagnostics() {
        return "existing daemon handle";
      },
      async stop() {},
    };
  }

  await ensureDaemonBuilt();
  if (process.platform !== "win32") {
    const tempDir = await mkdtemp(path.join(tmpdir(), "libravdbd-test-"));
    const unixEndpoint = `unix:${path.join(tempDir, "libravdb.sock")}`;
    try {
      return await launchDaemonAtEndpoint(unixEndpoint, tempDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("exited before becoming reachable") && !message.includes("operation not permitted")) {
        await rm(tempDir, { recursive: true, force: true });
        throw error;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "libravdbd-test-"));
  try {
    return await launchDaemonAtEndpoint("tcp:127.0.0.1:0", tempDir);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}
