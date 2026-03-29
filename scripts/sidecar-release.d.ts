export const SIDECAR_RELEASE_REPO: string;
export const SIDECAR_RELEASE_TARGETS: Record<string, string>;
export function detectSidecarReleaseTarget(platform?: string, arch?: string): string | null;
export function buildSidecarReleaseAssetURL(version: string, target: string): string;
