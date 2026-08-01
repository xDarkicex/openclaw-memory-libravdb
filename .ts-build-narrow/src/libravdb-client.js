import { createPromiseClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { LibravDB } from "@xdarkicex/libravdb-contracts/client";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import { formatError } from "./format-error.js";
import net from "node:net";
import os from "node:os";
import path from "node:path";
export function resolveClientEndpoint(configuredEndpoint) {
    if (configuredEndpoint && configuredEndpoint !== "auto")
        return configuredEndpoint;
    if (process.env.LIBRAVDB_GRPC_ENDPOINT)
        return process.env.LIBRAVDB_GRPC_ENDPOINT;
    if (process.platform === "win32")
        return "tcp:127.0.0.1:37421";
    const sockName = "libravdb.sock";
    const candidateDirs = [
        path.join(os.homedir(), ".libravdbd", "run"),
        "/opt/homebrew/var/libravdbd/run",
        "/usr/local/var/libravdbd/run",
        "/var/run/libravdbd",
        "/run/libravdbd",
    ];
    for (const dir of candidateDirs) {
        const fullPath = path.join(dir, sockName);
        if (fs.existsSync(fullPath))
            return `unix:${fullPath}`;
    }
    return `unix:${path.join(os.homedir(), ".libravdbd", "run", sockName)}`;
}
export function isLegacyJsonRpcHealthResponse(payload) {
    try {
        const parsed = JSON.parse(payload.trim());
        return parsed.jsonrpc === "2.0" && parsed.result?.ok === true;
    }
    catch {
        return false;
    }
}
export async function detectLegacyJsonRpcDaemon(endpoint, timeoutMs = 500) {
    if (!endpoint.startsWith("unix:")) {
        return false;
    }
    const socketPath = endpoint.slice(5);
    if (!socketPath) {
        return false;
    }
    return await new Promise((resolve) => {
        let settled = false;
        let response = "";
        const socket = net.createConnection(socketPath);
        const finish = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            socket.removeAllListeners();
            socket.destroy();
            resolve(value);
        };
        const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
        timer.unref?.();
        socket.setEncoding("utf8");
        socket.on("connect", () => {
            socket.write('{"jsonrpc":"2.0","id":1,"method":"health","params":{}}\n');
        });
        socket.on("data", (chunk) => {
            response += chunk;
            if (isLegacyJsonRpcHealthResponse(response)) {
                finish(true);
            }
            else if (response.length > 4096) {
                finish(false);
            }
        });
        socket.on("end", () => finish(isLegacyJsonRpcHealthResponse(response)));
        socket.on("close", () => finish(isLegacyJsonRpcHealthResponse(response)));
        socket.on("error", () => finish(false));
    });
}
function createRpcMutex() {
    return {
        current: Promise.resolve(),
        async lock() {
            let release;
            const p = new Promise(r => release = r);
            const prev = this.current;
            this.current = prev.then(() => p);
            await prev;
            return release;
        }
    };
}
export function createAuthInterceptor(state) {
    return (next) => async (req) => {
        // Health does not participate in the nonce chain — bypass the
        // mutex entirely so recovery can call Health without deadlocking.
        if (req.method.name === "Health") {
            return next(req);
        }
        const release = await state.rpcMutex.lock();
        try {
            // Lost the nonce? Recover inside the lock so queued requests
            // wait for the chain to be restored instead of failing spuriously.
            if (state.secret && !state.nonceHex) {
                await state.bootstrap();
                if (!state.nonceHex) {
                    throw new Error("LibraVDB: bootstrap handshake did not return a nonce");
                }
            }
            if (state.secret && state.nonceHex) {
                const hmac = createHmac("sha256", state.secret);
                hmac.update(state.nonceHex);
                req.header.set("x-libravdb-nonce", state.nonceHex);
                req.header.set("x-libravdb-auth", hmac.digest("hex"));
            }
            let res;
            try {
                res = await next(req);
            }
            catch (error) {
                if (state.secret && state.nonceHex) {
                    state.nonceHex = undefined;
                }
                throw error;
            }
            if (state.secret) {
                const nextNonce = res.header.get("x-libravdb-nonce") || res.trailer.get("x-libravdb-nonce");
                if (nextNonce) {
                    state.nonceHex = nextNonce;
                }
                else {
                    state.nonceHex = undefined;
                }
            }
            return res;
        }
        finally {
            release();
        }
    };
}
export class LibravDBClient {
    client;
    secret;
    endpoint;
    legacyProbeTimeoutMs;
    nonceHex;
    closed = false;
    constructor(options = {}) {
        this.secret = options.secret ?? loadSecretFromEnv();
        const rawEndpoint = resolveClientEndpoint(options.endpoint);
        this.endpoint = rawEndpoint;
        this.legacyProbeTimeoutMs = Math.min(options.timeoutMs ?? 30000, 1000);
        const isUnix = rawEndpoint.startsWith("unix:");
        const socketPath = isUnix ? rawEndpoint.slice(5) : undefined;
        const credMode = resolveCredentialMode(rawEndpoint, options.tlsMode);
        const isInsecure = isUnix || credMode === "insecure";
        const targetUrl = isUnix
            ? "http://localhost"
            : rawEndpoint.replace(/^tcp:/, isInsecure ? "http://" : "https://");
        let rootCerts = null;
        let clientKey = null;
        let clientCert = null;
        if (!isInsecure && options.tlsCaPath) {
            rootCerts = fs.readFileSync(options.tlsCaPath);
        }
        if (options.tlsClientCertPath && options.tlsClientKeyPath) {
            clientCert = fs.readFileSync(options.tlsClientCertPath);
            clientKey = fs.readFileSync(options.tlsClientKeyPath);
        }
        const rpcMutex = createRpcMutex();
        const self = this;
        const authInterceptor = createAuthInterceptor({
            secret: this.secret,
            get nonceHex() { return self.nonceHex; },
            set nonceHex(v) { self.nonceHex = v; },
            bootstrap: () => self.bootstrapHandshake(),
            rpcMutex,
        });
        const interceptors = [];
        if (options.tenantKey) {
            const tenantKey = options.tenantKey;
            interceptors.push((next) => async (req) => {
                req.header.set("libravdb-tenant-key", tenantKey);
                return next(req);
            });
        }
        interceptors.push(authInterceptor);
        const transport = createGrpcTransport({
            baseUrl: targetUrl,
            httpVersion: "2",
            nodeOptions: isUnix
                ? { createConnection: () => net.connect(socketPath) }
                : {
                    ...(rootCerts ? { ca: rootCerts } : {}),
                    ...(clientKey ? { key: clientKey } : {}),
                    ...(clientCert ? { cert: clientCert } : {}),
                    ...(isInsecure ? { rejectUnauthorized: false } : {}),
                },
            defaultTimeoutMs: options.timeoutMs ?? 30000,
            interceptors,
        });
        this.client = createPromiseClient(LibravDB, transport);
    }
    async bootstrapHandshake() {
        this.guardOpen();
        try {
            await this.client.health({ service: "" }, {
                onHeader: (headers) => {
                    const nonce = headers.get("x-libravdb-nonce");
                    if (nonce)
                        this.nonceHex = nonce;
                },
            });
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (detail.includes("Protocol error") && await detectLegacyJsonRpcDaemon(this.endpoint, this.legacyProbeTimeoutMs)) {
                throw new Error(`LibraVDB: failed to handshake with daemon: ${detail}. ` +
                    "The endpoint answered legacy JSON-RPC health; this plugin requires a gRPC-compatible libravdbd daemon. " +
                    "Update or restart libravdbd with gRPC support, or pin the plugin to a daemon-compatible release.");
            }
            throw new Error(`LibraVDB: failed to handshake with daemon: ${detail}`);
        }
    }
    guardOpen() {
        if (this.closed) {
            throw new Error("LibravDB client is closed");
        }
    }
    // ── Session lifecycle ────────────────────────────────────────────
    async health(req = {}) {
        this.guardOpen();
        return this.client.health(req);
    }
    async status(req = {}) {
        this.guardOpen();
        return this.client.status(req);
    }
    async flush(req = {}) {
        this.guardOpen();
        return this.client.flush(req);
    }
    async sessionLifecycleHint(req) {
        this.guardOpen();
        return this.client.sessionLifecycleHint(req);
    }
    async listLifecycleJournal(req) {
        this.guardOpen();
        return this.client.listLifecycleJournal(req);
    }
    // ── Ingest ───────────────────────────────────────────────────────
    async ingestMarkdownDocument(req) {
        this.guardOpen();
        return this.client.ingestMarkdownDocument(req);
    }
    async promoteDreamEntries(req) {
        this.guardOpen();
        return this.client.promoteDreamEntries(req);
    }
    async reindexAuthoredDocument(req) {
        this.guardOpen();
        return this.client.reindexAuthoredDocument(req);
    }
    async deleteAuthoredDocument(req) {
        this.guardOpen();
        return this.client.deleteAuthoredDocument(req);
    }
    async markMemorySuperseded(req) {
        this.guardOpen();
        return this.client.markMemorySuperseded(req);
    }
    // ── Search / query ───────────────────────────────────────────────
    async searchText(req) {
        this.guardOpen();
        return this.client.searchText(req);
    }
    async searchTextCollections(req) {
        this.guardOpen();
        return this.client.searchTextCollections(req);
    }
    async listCollection(req) {
        this.guardOpen();
        return this.client.listCollection(req);
    }
    // ── Memory ───────────────────────────────────────────────────────
    async exportMemory(req) {
        this.guardOpen();
        return this.client.exportMemory(req);
    }
    async flushNamespace(req) {
        this.guardOpen();
        return this.client.flushNamespace(req);
    }
    // ── Index ────────────────────────────────────────────────────────
    async rebuildIndex(req, opts) {
        this.guardOpen();
        return this.client.rebuildIndex(req, opts);
    }
    // ── Kernel ───────────────────────────────────────────────────────
    async bootstrapSessionKernel(req) {
        this.guardOpen();
        return this.client.bootstrapSessionKernel(req);
    }
    async ingestMessageKernel(req) {
        this.guardOpen();
        return this.client.ingestMessageKernel(req);
    }
    async afterTurnKernel(req) {
        this.guardOpen();
        return this.client.afterTurnKernel(req);
    }
    async beforeTurnKernel(req) {
        this.guardOpen();
        return this.client.beforeTurnKernel(req);
    }
    async assembleContextInternal(req) {
        this.guardOpen();
        return this.client.assembleContextInternal(req);
    }
    async compactSession(req) {
        this.guardOpen();
        return this.client.compactSession(req);
    }
    async summarizeMessages(req) {
        this.guardOpen();
        return this.client.summarizeMessages(req);
    }
    async expandSummary(req) {
        this.guardOpen();
        return this.client.expandSummary(req);
    }
    async rankCandidates(req) {
        this.guardOpen();
        return this.client.rankCandidates(req);
    }
    close() {
        this.closed = true;
    }
}
function resolveCredentialMode(endpoint, tlsMode) {
    if (tlsMode === "tls")
        return "tls";
    if (tlsMode === "insecure")
        return "insecure";
    const target = endpoint.startsWith("tcp:") ? endpoint.slice(4) : endpoint;
    if (target.startsWith("unix:"))
        return "insecure";
    const host = extractHost(target);
    const normalized = host.toLowerCase();
    return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1"
        ? "insecure"
        : "tls";
}
function extractHost(target) {
    const withoutDns = target.startsWith("dns:///") ? target.slice("dns:///".length) : target;
    if (withoutDns.startsWith("[")) {
        const close = withoutDns.indexOf("]");
        return close > 0 ? withoutDns.slice(1, close) : withoutDns;
    }
    const sep = withoutDns.lastIndexOf(":");
    return sep > 0 ? withoutDns.slice(0, sep) : withoutDns;
}
export function loadSecretFromEnv(logger) {
    const secret = process.env.LIBRAVDB_AUTH_SECRET?.trim();
    if (secret)
        return secret;
    const secretPath = process.env.LIBRAVDB_AUTH_SECRET_FILE;
    if (secretPath) {
        try {
            return fs.readFileSync(secretPath, "utf8").trim() || undefined;
        }
        catch (error) {
            logger?.warn?.(`LibraVDB: failed to read auth secret file "${secretPath}": ${formatError(error)}`);
            return undefined;
        }
    }
    return undefined;
}
