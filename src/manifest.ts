import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";

export interface TurnEntry {
  index: number;
  role: string;
  contentHash: string;
  idHash?: string;
  turnHash: string;
  ingestedAt: number;
}

export interface TurnManifest {
  sessionId: string;
  destination?: string;
  version: number;
  turns: TurnEntry[];
  tailHash: string;
  /** Cursor-gap source reseeding is incomplete; retry the full host source
   * instead of applying its new-turn prePromptMessageCount boundary. */
  recoveryPending?: boolean;
}

export interface KernelCompatibleMessage {
  role: string;
  content: string;
  id?: string;
}

export class TurnManifestStore {
  private readonly manifestDirOverride?: string;

  constructor(manifestDir?: string, private readonly destination?: string) {
    this.manifestDirOverride = manifestDir;
  }

  private getManifestPath(sessionId: string): string {
    const digest = this.hashString(sessionId);
    const directory = this.destination
      ? path.join(this.getManifestDir(), "destinations", this.hashString(this.destination))
      : this.getManifestDir();
    return path.join(directory, `${digest}.manifest.json`);
  }

  private getManifestDir(): string {
    if (this.manifestDirOverride) {
      return this.manifestDirOverride;
    }
    const stateRoot = process.env.OPENCLAW_STATE_DIR?.trim();
    return path.join(stateRoot || path.join(os.homedir(), ".openclaw"), "libravdb-manifests");
  }

  public hashString(data: string): string {
    return crypto.createHash("sha256").update(data).digest("hex");
  }

  public createEmpty(sessionId: string): TurnManifest {
    return {
      sessionId,
      version: 0,
      turns: [],
      tailHash: "0000000000000000000000000000000000000000000000000000000000000000",
    };
  }

  public load(sessionId: string, logger?: { warn?: (msg: string) => void; error?: (msg: string, e: unknown) => void }): TurnManifest {
    const filePath = this.getManifestPath(sessionId);

    if (!fs.existsSync(filePath)) {
      if (!this.destination) return this.createEmpty(sessionId);
      // Adopt a legacy checkpoint once, without re-sending an already-ACKed
      // transcript. Keep the claim in the old file so a different destination
      // cannot adopt the same acknowledgment on its first use.
      const legacyPath = path.join(this.getManifestDir(), `${this.hashString(sessionId)}.manifest.json`);
      if (!fs.existsSync(legacyPath)) return this.createEmpty(sessionId);
      let legacy: TurnManifest;
      const raw = fs.readFileSync(legacyPath, "utf8");
      try {
        legacy = JSON.parse(raw) as TurnManifest;
        if (legacy.sessionId !== sessionId || !this.verifyChain(legacy)) return this.createEmpty(sessionId);
        if (legacy.destination && legacy.destination !== this.destination) return this.createEmpty(sessionId);
      } catch (error) {
        logger?.error?.(`[LibraVDB] Invalid legacy manifest for ${sessionId}. Forcing re-sync:`, error);
        return this.createEmpty(sessionId);
      }
      try {
        const claimed = { ...legacy, destination: this.destination };
        if (!legacy.destination) this.writeManifest(legacyPath, claimed);
        this.save(claimed);
        return claimed;
      } catch (error) {
        logger?.error?.(`[LibraVDB] Failed to migrate manifest for ${sessionId}:`, error);
        throw error;
      }
    }

    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const manifest = JSON.parse(raw) as TurnManifest;

      if (manifest.sessionId !== sessionId) {
        logger?.warn?.(`[LibraVDB] Manifest session mismatch for ${sessionId}. Forcing re-sync.`);
        return this.createEmpty(sessionId);
      }

      if (this.destination && manifest.destination !== this.destination) {
        logger?.warn?.(`[LibraVDB] Manifest destination mismatch for ${sessionId}. Forcing re-sync.`);
        return this.createEmpty(sessionId);
      }

      if (!this.verifyChain(manifest)) {
        logger?.warn?.(`[LibraVDB] Manifest chain broken for session ${sessionId}. Forcing re-sync.`);
        return this.createEmpty(sessionId);
      }

      return manifest;
    } catch (e) {
      logger?.error?.(`[LibraVDB] Failed to read manifest for ${sessionId}:`, e);
      return this.createEmpty(sessionId);
    }
  }

  public save(manifest: TurnManifest): void {
    this.writeManifest(this.getManifestPath(manifest.sessionId), {
      ...manifest,
      ...(this.destination ? { destination: this.destination } : {}),
    });
  }

  private writeManifest(filePath: string, manifest: TurnManifest): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(manifest, null, 2), "utf8");
      fs.renameSync(tempPath, filePath);
    } finally {
      try { fs.unlinkSync(tempPath); } catch { /* rename succeeded or no staging file was created */ }
    }
  }

  public verifyChain(manifest: TurnManifest): boolean {
    let currentHash = "0000000000000000000000000000000000000000000000000000000000000000";

    for (const turn of manifest.turns) {
      const expectedHash = this.hashString(`${turn.index}${turn.role}${turn.contentHash}${currentHash}`);
      if (turn.turnHash !== expectedHash) {
        return false;
      }
      currentHash = expectedHash;
    }

    return manifest.tailHash === currentHash;
  }

  /**
   * Finds the overlap point between incoming messages and our stored history.
   * Returns the index into incomingMessages where new (un-ACKed) messages begin.
   * Returns 0 if no overlap (full re-sync).
   */
  public findOverlapIndex(
    manifest: TurnManifest,
    incomingMessages: KernelCompatibleMessage[],
  ): number {
    if (manifest.turns.length === 0) {
      return 0;
    }

    const maxOverlap = Math.min(manifest.turns.length, incomingMessages.length);
    for (let overlapLength = maxOverlap; overlapLength > 0; overlapLength--) {
      if (this.matchesManifestTail(manifest.turns, incomingMessages, overlapLength)) {
        return overlapLength;
      }
    }

    // No overlap found — OpenClaw trimmed too much or session diverged
    return 0;
  }

  private matchesManifestTail(
    turns: TurnEntry[],
    incomingMessages: KernelCompatibleMessage[],
    overlapLength: number,
  ): boolean {
    const manifestStart = turns.length - overlapLength;
    let hasMessageIdentity = false;

    for (let i = 0; i < overlapLength; i++) {
      const turn = turns[manifestStart + i];
      const msg = incomingMessages[i];
      if (!turn || !msg || turn.role !== msg.role || turn.contentHash !== this.hashString(msg.content)) {
        return false;
      }
      const incomingIdHash = msg.id ? this.hashString(msg.id) : undefined;
      if (turn.idHash || incomingIdHash) {
        if (turn.idHash === incomingIdHash) {
          hasMessageIdentity = true;
        } else if (overlapLength === 1) {
          return false;
        }
      }
    }

    return hasMessageIdentity || overlapLength > 1;
  }

  public appendACKedMessages(
    manifest: TurnManifest,
    newMessages: KernelCompatibleMessage[],
    startingIndex: number,
  ): TurnManifest {
    let currentHash = manifest.tailHash;
    const newTurns: TurnEntry[] = [];

    for (let i = 0; i < newMessages.length; i++) {
      const msg = newMessages[i];
      const absoluteIndex = startingIndex + i;
      const contentHash = this.hashString(msg.content);
      const idHash = msg.id ? this.hashString(msg.id) : undefined;

      currentHash = this.hashString(`${absoluteIndex}${msg.role}${contentHash}${currentHash}`);

      newTurns.push({
        index: absoluteIndex,
        role: msg.role,
        contentHash,
        ...(idHash ? { idHash } : {}),
        turnHash: currentHash,
        ingestedAt: Date.now(),
      });
    }

    return {
      sessionId: manifest.sessionId,
      version: manifest.version + 1,
      turns: [...manifest.turns, ...newTurns],
      tailHash: currentHash,
    };
  }

  /**
   * Determines the absolute starting index for a set of new messages.
   * If we have stored turns, the next message's index is last_turn.index + 1.
   * If the manifest is empty, we infer from OpenClaw's prePromptMessageCount signal
   * (caller must provide this as a hint when available).
   */
  public deriveStartingIndex(manifest: TurnManifest, prePromptMessageCountHint?: number): number {
    if (manifest.turns.length > 0) {
      return manifest.turns[manifest.turns.length - 1].index + 1;
    }
    // Empty manifest — use OpenClaw's signal if provided, else assume 0
    return typeof prePromptMessageCountHint === "number" && prePromptMessageCountHint >= 0
      ? prePromptMessageCountHint
      : 0;
  }
}

export const manifestStore = new TurnManifestStore();
