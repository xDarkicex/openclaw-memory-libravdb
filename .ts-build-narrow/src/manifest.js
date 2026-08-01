import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
export class TurnManifestStore {
    manifestDir;
    constructor() {
        this.manifestDir = path.join(os.homedir(), ".openclaw", "libravdb-manifests");
        if (!fs.existsSync(this.manifestDir)) {
            fs.mkdirSync(this.manifestDir, { recursive: true });
        }
    }
    getManifestPath(sessionId) {
        const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
        return path.join(this.manifestDir, `${safe}.manifest.json`);
    }
    hashString(data) {
        return crypto.createHash("sha256").update(data).digest("hex");
    }
    createEmpty(sessionId) {
        return {
            sessionId,
            version: 0,
            turns: [],
            tailHash: "0000000000000000000000000000000000000000000000000000000000000000",
        };
    }
    load(sessionId, logger) {
        const filePath = this.getManifestPath(sessionId);
        if (!fs.existsSync(filePath)) {
            return this.createEmpty(sessionId);
        }
        try {
            const raw = fs.readFileSync(filePath, "utf8");
            const manifest = JSON.parse(raw);
            if (!this.verifyChain(manifest)) {
                logger?.warn?.(`[LibraVDB] Manifest chain broken for session ${sessionId}. Forcing re-sync.`);
                return this.createEmpty(sessionId);
            }
            return manifest;
        }
        catch (e) {
            logger?.error?.(`[LibraVDB] Failed to read manifest for ${sessionId}:`, e);
            return this.createEmpty(sessionId);
        }
    }
    save(manifest) {
        const filePath = this.getManifestPath(manifest.sessionId);
        const tempPath = `${filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(manifest, null, 2), "utf8");
        fs.renameSync(tempPath, filePath);
    }
    verifyChain(manifest) {
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
    findOverlapIndex(manifest, incomingMessages) {
        if (manifest.turns.length === 0) {
            return 0;
        }
        // Build a map of contentHash → index in our manifest
        const known = new Map();
        for (const turn of manifest.turns) {
            known.set(turn.contentHash, turn.index);
        }
        // Scan incoming messages from newest to oldest to find the last match
        for (let i = incomingMessages.length - 1; i >= 0; i--) {
            const contentHash = this.hashString(incomingMessages[i].content);
            if (known.has(contentHash)) {
                return i + 1; // everything at and after this index is new
            }
        }
        // No overlap found — OpenClaw trimmed too much or session diverged
        return 0;
    }
    appendACKedMessages(manifest, newMessages, startingIndex) {
        let currentHash = manifest.tailHash;
        const newTurns = [];
        for (let i = 0; i < newMessages.length; i++) {
            const msg = newMessages[i];
            const absoluteIndex = startingIndex + i;
            const contentHash = this.hashString(msg.content);
            currentHash = this.hashString(`${absoluteIndex}${msg.role}${contentHash}${currentHash}`);
            newTurns.push({
                index: absoluteIndex,
                role: msg.role,
                contentHash,
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
    deriveStartingIndex(manifest, prePromptMessageCountHint) {
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
