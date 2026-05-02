import { RpcRequest, RpcResponse } from "./generated/libravdb/ipc/v1/rpc_pb.js";
import { getRpcMethodCodec } from "./rpc-protobuf-codecs.js";
import type { RpcCallOptions, SidecarSocket } from "./types.js";

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  decodeResult(bytes: Uint8Array): unknown;
}

export class RpcClient {
  private seq = 0n;
  private readonly pending = new Map<bigint, PendingCall>();
  private rxBuf = Buffer.alloc(0);
  private sentMagic = false;

  constructor(
    private readonly socket: SidecarSocket,
    private readonly options: RpcCallOptions,
  ) {
    // Remove socket.setEncoding("utf8"); completely. The socket must stay binary.
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("close", () => {
      this.sentMagic = false; // Force magic byte on next reconnect
      this.rejectAll(new Error("Socket closed"));
    });
    socket.on("error", (error) => this.rejectAll(error));
  }

  async call<T>(method: string, params: unknown, callOptions: Partial<RpcCallOptions> = {}): Promise<T> {
    const codec = getRpcMethodCodec(method);
    if (!codec) {
      throw new Error(`Unsupported LibraVDB RPC method for protobuf transport: ${method}`);
    }

    return await new Promise<T>((resolve, reject) => {
      const id = ++this.seq;
      const timeoutMs = callOptions.timeoutMs ?? this.options.timeoutMs;
      const deadline = Date.now() + timeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, decodeResult: codec.decodeResult });

      const buildFrame = () => {
        const envelope = new (RpcRequest as any)({
          id,
          method,
          params: codec.encodeParams(params),
        });
        const payload = Buffer.from(envelope.toBinary());
        const header = Buffer.alloc(4);
        header.writeUInt32BE(payload.byteLength, 0);
        const chunks: Buffer[] = [];
        const includesMagic = !this.sentMagic;
        if (includesMagic) {
          chunks.push(Buffer.from([0x02]));
        }
        chunks.push(header, payload);
        return { frame: Buffer.concat(chunks), includesMagic };
      };

      const send = (allowReconnectRetry: boolean) => {
        if (!this.pending.has(id)) {
          return;
        }
        const { frame, includesMagic } = buildFrame();
        try {
          this.socket.write(frame);
          if (includesMagic) {
            this.sentMagic = true;
          }
        } catch (error) {
          if (allowReconnectRetry && isReconnectableSocketGap(error)) {
            this.sentMagic = false;
            const remainingMs = Math.max(0, deadline - Date.now());
            if (remainingMs <= 0) {
              if (!this.pending.has(id)) {
                return;
              }
              clearTimeout(timer);
              this.pending.delete(id);
              reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
              return;
            }
            void this.waitForReconnect(remainingMs)
              .then(() => {
                if (!this.pending.has(id)) {
                  return;
                }
                send(false);
              })
              .catch((reconnectError) => {
                if (!this.pending.has(id)) {
                  return;
                }
                clearTimeout(timer);
                this.pending.delete(id);
                const error = reconnectError instanceof Error
                  ? reconnectError
                  : new Error(String(reconnectError));
                reject(
                  /^Sidecar reconnect timed out/.test(error.message)
                    ? new Error(`RPC timeout: ${method} (${timeoutMs}ms)`)
                    : error,
                );
              });
            return;
          }
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      send(true);
    });
  }

  private async waitForReconnect(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onConnect = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket.off("connect", onConnect);
        reject(error);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.socket.off("connect", onConnect);
        this.socket.off("error", onError);
        reject(new Error(`Sidecar reconnect timed out (${timeoutMs}ms)`));
      }, timeoutMs);

      this.socket.once("connect", onConnect);
      this.socket.once("error", onError);
    });
  }

  private handleData(chunk: Buffer): void {
    if (chunk.byteLength > 64 << 20) {
      this.socket.destroy();
      return;
    }

    this.rxBuf = Buffer.concat([this.rxBuf, chunk]);

    while (this.rxBuf.byteLength >= 4) {
      const payloadLength = this.rxBuf.readUInt32BE(0);
      if (payloadLength > 64 << 20) {
        this.socket.destroy();
        return;
      }
      const frameSize = 4 + payloadLength;

      // Wait for the full frame to arrive
      if (this.rxBuf.byteLength < frameSize) {
        break;
      }

      const payload = this.rxBuf.subarray(4, frameSize);
      this.rxBuf = this.rxBuf.subarray(frameSize);

      this.dispatchMessage(payload);
    }

    // Compaction guard: release large backing allocations if the remainder is tiny
    if (
      this.rxBuf.buffer.byteLength > 65536 &&
      this.rxBuf.byteLength < this.rxBuf.buffer.byteLength >>> 2
    ) {
      this.rxBuf = Buffer.from(this.rxBuf);
    }
  }

  private dispatchMessage(payload: Buffer): void {
    try {
      const msg = RpcResponse.fromBinary(payload as Uint8Array);

      if (typeof msg.id !== "bigint") {
        this.socket.destroy(new Error("Protocol violation: expected bigint message id"));
        return;
      }

      const pending = this.pending.get(msg.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      this.pending.delete(msg.id);

      if (msg.error) {
        const message = msg.error.message?.trim() || `RPC error ${msg.error.code}`;
        pending.reject(new Error(msg.error.code ? `${message} (${msg.error.code})` : message));
        return;
      }

      try {
        pending.resolve(pending.decodeResult(msg.result));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    } catch {
      // Ignore malformed frames
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function isReconnectableSocketGap(error: unknown): boolean {
  return error instanceof Error && /Sidecar socket unavailable/i.test(error.message);
}
