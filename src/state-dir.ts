import os from "node:os";
import path from "node:path";

/**
 * Resolve the OpenClaw state directory.
 *
 * Resolution order:
 *   1. `OPENCLAW_STATE_DIR` env var (trimmed, must be non-empty)
 *   2. `~/.openclaw` (default)
 */
export function resolveStateDir(): string {
  const envVal = process.env.OPENCLAW_STATE_DIR?.trim();
  if (envVal) return envVal;
  return path.join(os.homedir(), ".openclaw");
}