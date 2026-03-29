export const SIDECAR_RELEASE_REPO = "https://github.com/xDarkicex/openclaw-memory-libravdb/releases/download";

export const SIDECAR_RELEASE_TARGETS = {
  "darwin-arm64": "clawdb-sidecar-darwin-arm64",
  "darwin-x64": "clawdb-sidecar-darwin-amd64",
  "linux-x64": "clawdb-sidecar-linux-amd64",
  "linux-arm64": "clawdb-sidecar-linux-arm64",
  "win32-x64": "clawdb-sidecar-windows-amd64.exe",
};

export function detectSidecarReleaseTarget(platform = process.platform, arch = process.arch) {
  return SIDECAR_RELEASE_TARGETS[`${platform}-${arch}`] ?? null;
}

export function buildSidecarReleaseAssetURL(version, target) {
  return `${SIDECAR_RELEASE_REPO}/v${version}/${target}`;
}
