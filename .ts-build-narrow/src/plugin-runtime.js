import { LibravDBClient, resolveClientEndpoint } from "./libravdb-client.js";
import { formatError } from "./format-error.js";
import { resolveTenantKey } from "./identity.js";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
export const DEFAULT_RPC_TIMEOUT_MS = 120_000;
export const STARTUP_HEALTH_TIMEOUT_MS = 2000;
const ENV_RPC_TIMEOUT_MS = (() => {
    const raw = Number(process.env.LIBRAVDB_RPC_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
})();
export const VALID_TLS_MODES = ["auto", "tls", "insecure"];
const isTlsModeValid = (m) => VALID_TLS_MODES.includes(m);
export function resolveStartupHealthTimeoutMs(cfg) {
    const timeout = cfg.rpcTimeoutMs ?? (ENV_RPC_TIMEOUT_MS || DEFAULT_RPC_TIMEOUT_MS);
    return Math.max(STARTUP_HEALTH_TIMEOUT_MS, timeout);
}
export function daemonProvisioningHint() {
    return "If you installed the npm package, install and start libravdbd separately; the package does not provision the daemon binary, ONNX Runtime, or model assets.";
}
export function validateEmbeddingConfig(cfg) {
    if (cfg.embeddingBackend !== "onnx-local") {
        return;
    }
    const runtimePath = cfg.embeddingRuntimePath?.trim();
    const modelPath = cfg.embeddingModelPath?.trim();
    if (!runtimePath || !modelPath) {
        throw new Error(`LibraVDB: embeddingBackend="onnx-local" requires embeddingRuntimePath and embeddingModelPath. ` +
            `Start libravdbd with matching LIBRAVDB_ONNX_RUNTIME and LIBRAVDB_EMBEDDING_MODEL values.`);
    }
    if (!shouldValidateLocalEmbeddingPaths(cfg)) {
        return;
    }
    if (!pathExistsAsFile(runtimePath)) {
        throw new Error(`LibraVDB: embeddingRuntimePath must point to a readable ONNX Runtime library: ${runtimePath}`);
    }
    if (!pathExistsAsDirectory(modelPath) || !pathExistsAsFile(path.join(modelPath, "embedding.json"))) {
        throw new Error(`LibraVDB: embeddingModelPath must point to a directory containing embedding.json: ${modelPath}`);
    }
}
export function createPluginRuntime(cfg, logger = console) {
    let started = null;
    let stopped = false;
    let shuttingDown = false;
    const shutdownTasks = [];
    const ensureStarted = async () => {
        if (stopped) {
            throw new Error("LibraVDB plugin runtime has been shut down");
        }
        if (!started) {
            let client;
            started = (async () => {
                validateEmbeddingConfig(cfg);
                validateTlsConfig(cfg, logger);
                client = new LibravDBClient({
                    endpoint: cfg.grpcEndpoint || cfg.sidecarPath,
                    timeoutMs: cfg.rpcTimeoutMs ?? (ENV_RPC_TIMEOUT_MS || DEFAULT_RPC_TIMEOUT_MS),
                    tlsCaPath: cfg.grpcEndpointTlsCa,
                    tlsMode: cfg.grpcEndpointTlsMode,
                    tlsClientCertPath: cfg.grpcEndpointTlsClientCert,
                    tlsClientKeyPath: cfg.grpcEndpointTlsClientKey,
                    tenantKey: resolveTenantKey(cfg),
                });
                await client.bootstrapHandshake();
                return client;
            })().catch((error) => {
                started = null;
                client?.close();
                throw enrichStartupError(error);
            });
        }
        return await started;
    };
    return {
        async getClient() {
            return await ensureStarted();
        },
        async emitLifecycleHint(hint) {
            try {
                const client = await ensureStarted();
                await client.sessionLifecycleHint(hint);
            }
            catch (error) {
                logger.warn?.(`LibraVDB lifecycle hint dropped: ${formatError(error)}`);
            }
        },
        onShutdown(task) {
            if (stopped || shuttingDown) {
                return;
            }
            shutdownTasks.push(task);
        },
        async shutdown() {
            if (stopped || shuttingDown) {
                return;
            }
            shuttingDown = true;
            for (const task of shutdownTasks.splice(0).reverse()) {
                try {
                    await task();
                }
                catch (error) {
                    logger.warn?.(`LibraVDB shutdown task failed: ${formatError(error)}`);
                }
            }
            stopped = true;
            if (!started) {
                return;
            }
            const client = started;
            started = null;
            try {
                const resolved = await client;
                try {
                    await resolved.flush({});
                }
                catch (error) {
                    logger.warn?.(`LibraVDB flush failed during shutdown: ${formatError(error)}`);
                }
                finally {
                    resolved.close();
                }
            }
            catch {
                // startup may have failed before client resolution; nothing to flush or close
            }
        },
    };
}
function shouldValidateLocalEmbeddingPaths(cfg) {
    // Resolve the same endpoint the client will use — respects LIBRAVDB_GRPC_ENDPOINT env var
    const endpoint = resolveClientEndpoint(cfg.grpcEndpoint || cfg.sidecarPath).trim();
    if (!endpoint || endpoint === "auto" || endpoint.startsWith("unix:")) {
        return true;
    }
    if (!endpoint.startsWith("tcp:")) {
        return false;
    }
    const target = endpoint.slice("tcp:".length);
    const host = target.startsWith("[")
        ? target.slice(1, target.indexOf("]"))
        : target.split(":")[0];
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
function pathExistsAsFile(filePath) {
    try {
        return existsSync(filePath) && statSync(filePath).isFile();
    }
    catch {
        return false;
    }
}
function pathExistsAsDirectory(dirPath) {
    try {
        return existsSync(dirPath) && statSync(dirPath).isDirectory();
    }
    catch {
        return false;
    }
}
function validateTlsConfig(cfg, logger) {
    if (cfg.grpcEndpointTlsMode !== undefined &&
        !isTlsModeValid(cfg.grpcEndpointTlsMode)) {
        throw new Error(`LibraVDB: invalid grpcEndpointTlsMode "${cfg.grpcEndpointTlsMode}" — ` +
            `must be "auto", "tls", or "insecure"`);
    }
    const hasClientCert = cfg.grpcEndpointTlsClientCert !== undefined;
    const hasClientKey = cfg.grpcEndpointTlsClientKey !== undefined;
    if (hasClientCert !== hasClientKey) {
        throw new Error("LibraVDB: grpcEndpointTlsClientCert and " +
            "grpcEndpointTlsClientKey must both be set or both be omitted");
    }
    if (cfg.grpcEndpointTlsMode === "insecure") {
        if (cfg.grpcEndpointTlsCa) {
            logger.warn?.(`LibraVDB: grpcEndpointTlsCa is set but grpcEndpointTlsMode ` +
                `is "insecure" — the CA file will not be used`);
        }
        if (cfg.grpcEndpointTlsClientCert) {
            logger.warn?.(`LibraVDB: grpcEndpointTlsClientCert is set but ` +
                `grpcEndpointTlsMode is "insecure" — client certificate ` +
                `will not be sent`);
        }
    }
}
export function enrichStartupError(error, healthMessage) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = rawMessage.trim() || "LibraVDB daemon startup failed";
    if (message.includes("package does not provision the daemon binary")) {
        return error instanceof Error ? error : new Error(message);
    }
    const shouldHint = /health check|daemon unavailable|connection refused|ECONNREFUSED|ENOENT|fallback mode|ONNX Runtime|embedder/i.test(`${message} ${healthMessage ?? ""}`);
    if (!shouldHint) {
        return error instanceof Error ? error : new Error(message);
    }
    const detail = healthMessage?.trim();
    const prefix = detail && !message.includes(detail) ? `${message}: ${detail}` : message;
    return new Error(`${prefix}. ${daemonProvisioningHint()}`);
}
