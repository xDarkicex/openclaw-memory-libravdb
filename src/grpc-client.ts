import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The proto file is expected to be copied to dist/proto/ at build time.
// In source, it's at api/proto/.
const PROTO_PATH = path.resolve(__dirname, "./proto/intelligence_kernel/v1/kernel.proto");

export interface GrpcClientOptions {
  endpoint: string;
  secret?: string;
  timeoutMs?: number;
  tlsCaPath?: string;
  tlsMode?: "auto" | "tls" | "insecure"; // exported type: use VALID_TLS_MODES from plugin-runtime for deriving new types
}

export function resolveGrpcTarget(endpoint: string): string {
  return endpoint.startsWith("tcp:") ? endpoint.substring(4) : endpoint;
}

/**
 * Selects gRPC credential mode based on endpoint address class.
 *
 * - Unix socket endpoints → plaintext (local-only transport)
 * - Loopback addresses (localhost, 127.0.0.1, ::1) → plaintext
 * - All other TCP and DNS targets → TLS
 *
 * resolveGrpcCredentials uses this classification to return the
 * appropriate grpc.ChannelCredentials. Pass tlsCaPath to load a
 * custom CA certificate PEM file for self-signed or private CA
 * deployments. Omit tlsCaPath for publicly trusted certificates
 * (Let's Encrypt, cert-manager) — the system CA pool is used.
 */
export function resolveGrpcCredentialMode(
  endpoint: string,
  tlsMode?: "auto" | "tls" | "insecure",
): "insecure" | "tls" {
  if (tlsMode === "tls") return "tls";
  if (tlsMode === "insecure") return "insecure";
  // "auto" or undefined — address-based heuristic
  const target = resolveGrpcTarget(endpoint).trim();
  if (target.startsWith("unix:")) return "insecure";
  const host = extractGrpcHost(target);
  return isLoopbackHost(host) ? "insecure" : "tls";
}

export function resolveGrpcCredentials(
  endpoint: string,
  tlsCaPath?: string,
  tlsMode?: "auto" | "tls" | "insecure",
): grpc.ChannelCredentials {
  if (resolveGrpcCredentialMode(endpoint, tlsMode) === "insecure") {
    return grpc.credentials.createInsecure();
  }
  if (tlsCaPath) {
    let rootCerts: Buffer;
    try {
      rootCerts = fs.readFileSync(tlsCaPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `LibraVDB: failed to load TLS CA certificate from "${tlsCaPath}": ${msg}`,
      );
    }
    return grpc.credentials.createSsl(rootCerts, null, null);
  }
  return grpc.credentials.createSsl();
}

function extractGrpcHost(target: string): string {
  const withoutDnsPrefix = target.startsWith("dns:///") ? target.slice("dns:///".length) : target;
  if (withoutDnsPrefix.startsWith("[")) {
    const closeBracket = withoutDnsPrefix.indexOf("]");
    return closeBracket > 0 ? withoutDnsPrefix.slice(1, closeBracket) : withoutDnsPrefix;
  }

  const portSeparator = withoutDnsPrefix.lastIndexOf(":");
  return portSeparator > 0 ? withoutDnsPrefix.slice(0, portSeparator) : withoutDnsPrefix;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export class GrpcKernelClient {
  private client: any;
  private readonly secret: string | undefined;
  private readonly timeoutMs: number;
  private nonceHex: string | undefined;

  constructor(options: GrpcClientOptions) {
    this.secret = options.secret;
    this.timeoutMs = options.timeoutMs ?? 30000;

    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
    const kernelService = protoDescriptor.intelligence_kernel.v1.IntelligenceKernel;

    const target = resolveGrpcTarget(options.endpoint);

    this.client = new kernelService(target, resolveGrpcCredentials(options.endpoint, options.tlsCaPath, options.tlsMode));
  }

  private getMetadata(signed = true): grpc.Metadata {
    const md = new grpc.Metadata();
    if (this.secret && signed) {
      if (!this.nonceHex) {
        throw new Error("call initializeSession before authenticated RPCs");
      }
      // Challenge-response: HMAC(secret, nonce) — the secret is the HMAC key,
      // the server-issued nonce is the message. The previous implementation
      // swapped these, computing HMAC(nonce, secret), which is cryptographically
      // incorrect: the nonce is sent in the clear and must not be used as the key.
      const hmac = createHmac("sha256", this.secret);
      hmac.update(this.nonceHex);
      const signature = hmac.digest("hex");
      md.add("x-libravdb-auth", signature);
    }
    return md;
  }

  private call<T>(method: string, req: any, signed = true): Promise<T> {
    return new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + this.timeoutMs);
      this.client[method](req, this.getMetadata(signed), { deadline }, (err: any, resp: T) => {
        if (err) {
          reject(err);
        } else {
          resolve(resp);
        }
      });
    });
  }

  async initializeSession(req: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + this.timeoutMs);
      this.client.InitializeSession(req, this.getMetadata(false), { deadline }, (err: any, resp: any) => {
        if (err) {
          reject(err);
          return;
        }
        const nonce = resp?.server_metadata?.nonce;
        if (this.secret && (typeof nonce !== "string" || nonce.length === 0)) {
          reject(new Error("InitializeSession response missing auth nonce"));
          return;
        }
        if (typeof nonce === "string" && nonce.length > 0) {
          this.nonceHex = nonce;
        }
        resolve(resp);
      });
    });
  }

  async assembleContext(req: any): Promise<any> {
    return this.call("AssembleContext", req);
  }

  async rankCandidates(req: any): Promise<any> {
    return this.call("RankCandidates", req);
  }

  async ingestMessage(req: any): Promise<any> {
    return this.call("IngestMessage", req);
  }

  async afterTurn(req: any): Promise<any> {
    return this.call("AfterTurn", req);
  }

  async bootstrapSession(req: any): Promise<any> {
    return this.call("BootstrapSession", req);
  }

  async compactSession(req: any): Promise<any> {
    return this.call("CompactSession", req);
  }

  async getStatus(req: any = {}): Promise<any> {
    return this.call("GetStatus", req);
  }

  close(): void {
    this.client.close();
  }
}
