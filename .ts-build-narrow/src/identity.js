import { userInfo, hostname } from "node:os";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
/**
 * Resolves the identity file path, respecting OpenClaw's state directory conventions.
 *
 * Resolution order:
 *   1. Plugin config `identityPath` override
 *   2. `OPENCLAW_STATE_DIR` env var + `/libravdb-identity.json`
 *   3. `~/.openclaw/libravdb-identity.json` (default)
 */
function resolveIdentityPath(configuredPath) {
    if (configuredPath)
        return configuredPath;
    const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
    if (stateDir)
        return join(stateDir, "libravdb-identity.json");
    const home = userInfo().homedir;
    return join(home, ".openclaw", "libravdb-identity.json");
}
function deriveIdentityParts() {
    let username;
    let home;
    try {
        const info = userInfo();
        username = info.username;
        home = info.homedir;
    }
    catch {
        username =
            process.env.USER || process.env.USERNAME || process.env.LOGNAME || "anon";
        home = process.env.HOME || process.env.USERPROFILE || "unknown";
    }
    const host = hostname();
    const homeHash = createHash("sha256")
        .update(home.replace(/\\/g, "/").toLowerCase())
        .digest("hex")
        .slice(0, 8);
    return { username, host, home, homeHash };
}
function deriveAutoId(parts) {
    return `${parts.username}@${parts.host}#${parts.homeHash}`;
}
function writeIdentityFile(path, userId, parts) {
    const identity = {
        userId,
        derivedFrom: {
            username: parts.username,
            hostname: parts.host,
            homeHash: parts.homeHash,
            platform: process.platform,
        },
        createdAt: new Date().toISOString(),
    };
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(identity, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    // POSIX mode bits are advisory on Windows — enforce owner-only access via ACLs.
    if (process.platform === "win32") {
        try {
            execSync(`icacls "${path}" /inheritance:r /grant:r "%USERNAME%:(R,W)"`, { stdio: "ignore", timeout: 5000 });
        }
        catch {
            // best-effort; the file is already written with 0o600
        }
    }
}
export function resolveIdentity(params) {
    // 1. Plugin config override (highest priority)
    const configUserId = params.configUserId?.trim();
    if (configUserId) {
        return { userId: configUserId, source: "config" };
    }
    const filePath = resolveIdentityPath(params.identityPath);
    // 2. Identity JSON file (portable, user-editable)
    if (existsSync(filePath)) {
        try {
            const raw = readFileSync(filePath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed.userId && typeof parsed.userId === "string") {
                const trimmed = parsed.userId.trim();
                if (trimmed.length > 0) {
                    return { userId: trimmed, source: "file" };
                }
            }
        }
        catch (error) {
            params.logger?.warn?.(`LibraVDB: failed to read identity file at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    // 3. Auto-derive; persist is best-effort — do not discard a valid derivation
    //    just because the identity file can't be written.
    let parts;
    try {
        parts = deriveIdentityParts();
    }
    catch {
        const fallback = params.sessionKey?.trim();
        if (fallback) {
            return { userId: `session-key:${fallback}`, source: "session-key" };
        }
        return { userId: "default", source: "default" };
    }
    const autoId = deriveAutoId(parts);
    if (params.noAutoPersist) {
        return { userId: autoId, source: "auto" };
    }
    try {
        writeIdentityFile(filePath, autoId, parts);
        params.logger?.info?.(`LibraVDB: auto-derived identity "${autoId}" written to ${filePath}`);
    }
    catch (error) {
        params.logger?.warn?.(`LibraVDB: failed to persist identity file at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { userId: autoId, source: "auto" };
}
/**
 * Resolves a stable tenant key for multi-agent DB routing.
 *
 * Priority chain:
 *   1. cfg.tenantId (explicit config, highest priority)
 *   2. LIBRAVDB_AGENT_ID env var (container/CI override)
 *   3. Fall back to resolved userId (existing identity system)
 */
export function resolveTenantKey(cfg) {
    const explicit = cfg.tenantId?.trim();
    if (explicit)
        return explicit;
    const envId = process.env.LIBRAVDB_AGENT_ID?.trim();
    if (envId)
        return envId;
    return resolveIdentity({
        configUserId: cfg.userId,
        identityPath: cfg.identityPath,
    }).userId;
}
