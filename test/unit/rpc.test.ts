import test from "node:test";
import assert from "node:assert/strict";

import { RpcClient } from "../../src/rpc.js";
import type { SidecarSocket } from "../../src/types.js";

class FakeSocket implements SidecarSocket {
  private dataHandlers: Array<(chunk: string) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private connectOnce: Array<() => void> = [];
  private errorOnce: Array<(error: Error) => void> = [];
  public writes: string[] = [];

  setEncoding(_encoding: string): void {}

  on(event: "data" | "close", handler: ((chunk: string) => void) | (() => void)): void {
    if (event === "data") this.dataHandlers.push(handler as (chunk: string) => void);
    else this.closeHandlers.push(handler as () => void);
  }

  once(event: "connect" | "error", handler: (() => void) | ((error: Error) => void)): void {
    if (event === "connect") this.connectOnce.push(handler as () => void);
    else this.errorOnce.push(handler as (error: Error) => void);
  }

  write(chunk: string): void {
    this.writes.push(chunk);
  }

  destroy(): void {
    for (const handler of this.closeHandlers) handler();
  }

  emitData(chunk: string): void {
    for (const handler of this.dataHandlers) handler(chunk);
  }
}

test("RpcClient resolves buffered multi-chunk responses", async () => {
  const socket = new FakeSocket();
  const client = new RpcClient(socket, { timeoutMs: 100 });

  const pending = client.call("health", {});
  socket.emitData('{"jsonrpc":"2.0","id":1,"result":{"ok":');
  socket.emitData('true}}\n');

  await assert.doesNotReject(pending);
});

test("RpcClient rejects on timeout", async () => {
  const socket = new FakeSocket();
  const client = new RpcClient(socket, { timeoutMs: 10 });

  await assert.rejects(client.call("health", {}), /RPC timeout/);
});

test("RpcClient rejects pending calls on close", async () => {
  const socket = new FakeSocket();
  const client = new RpcClient(socket, { timeoutMs: 100 });

  const pending = client.call("health", {});
  socket.destroy();

  await assert.rejects(pending, /Socket closed/);
});
