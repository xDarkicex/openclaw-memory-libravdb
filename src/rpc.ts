import type { RpcCallOptions, SidecarSocket } from "./types.js";

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcClient {
  private seq = 0;
  private readonly pending = new Map<number, PendingCall>();
  private buf = "";

  constructor(
    private readonly socket: SidecarSocket,
    private readonly options: RpcCallOptions,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("close", () => this.rejectAll(new Error("Socket closed")));
  }

  async call<T>(method: string, _params: unknown): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (${this.options.timeoutMs}ms)`));
      }, this.options.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params: _params })}\n`,
      );
    });
  }

  private handleData(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      try {
        const msg = JSON.parse(line) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (typeof msg.id !== "number") {
          continue;
        }

        const pending = this.pending.get(msg.id);
        if (!pending) {
          continue;
        }

        clearTimeout(pending.timer);
        this.pending.delete(msg.id);

        if (msg.error?.message) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      } catch {
        // Ignore malformed frames and keep parsing future lines.
      }
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
