import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function loadReleaseModule() {
  return await import(pathToFileURL(path.join(process.cwd(), "scripts", "sidecar-release.js")).href);
}

test("detectSidecarReleaseTarget matches the spec platform table", async () => {
  const {
    SIDECAR_RELEASE_TARGETS,
    detectSidecarReleaseTarget,
  } = await loadReleaseModule();

  assert.equal(detectSidecarReleaseTarget("darwin", "arm64"), "clawdb-sidecar-darwin-arm64");
  assert.equal(detectSidecarReleaseTarget("darwin", "x64"), "clawdb-sidecar-darwin-amd64");
  assert.equal(detectSidecarReleaseTarget("linux", "x64"), "clawdb-sidecar-linux-amd64");
  assert.equal(detectSidecarReleaseTarget("linux", "arm64"), "clawdb-sidecar-linux-arm64");
  assert.equal(detectSidecarReleaseTarget("win32", "x64"), "clawdb-sidecar-windows-amd64.exe");
  assert.equal(detectSidecarReleaseTarget("freebsd", "x64"), null);
  assert.equal(Object.keys(SIDECAR_RELEASE_TARGETS).length, 5);
});

test("buildSidecarReleaseAssetURL uses tagged release assets", async () => {
  const { buildSidecarReleaseAssetURL } = await loadReleaseModule();

  assert.equal(
    buildSidecarReleaseAssetURL("1.3.0", "clawdb-sidecar-linux-amd64"),
    "https://github.com/xDarkicex/openclaw-memory-libravdb/releases/download/v1.3.0/clawdb-sidecar-linux-amd64",
  );
});
