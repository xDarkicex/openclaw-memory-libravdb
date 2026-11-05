import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Each session owns its file, so independent engines cannot replace each other's state. */
export class ContinuityCache {
  constructor(private readonly stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw")) {}

  private filePath(sessionKey: string): string {
    const digest = createHash("sha256").update(sessionKey).digest("hex");
    return join(this.stateDir, "libravdb-continuity", `${digest}.json`);
  }

  read(sessionKey: string): string | undefined {
    try {
      const entry = JSON.parse(readFileSync(this.filePath(sessionKey), "utf8"));
      return entry?.sessionKey === sessionKey && typeof entry.text === "string" ? entry.text : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    // The old shared file is a read-only fallback. New writes never replace it,
    // and a per-session entry takes precedence once that session advances.
    try {
      const legacy = JSON.parse(readFileSync(join(this.stateDir, "libravdb-continuity-cache.json"), "utf8"));
      return typeof legacy?.[sessionKey] === "string" ? legacy[sessionKey] : undefined;
    } catch { return undefined; }
  }

  write(sessionKey: string, text: string): void {
    mkdirSync(join(this.stateDir, "libravdb-continuity"), { recursive: true });
    const destination = this.filePath(sessionKey);
    const staging = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(staging, JSON.stringify({ sessionKey, text }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(staging, destination);
    } finally {
      try { unlinkSync(staging); } catch { /* rename succeeded or staging was not created */ }
    }
  }
}
