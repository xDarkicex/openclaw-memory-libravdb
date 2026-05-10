import assert from "node:assert/strict";
import test from "node:test";

import {
  AssembleContextInternalResponse,
  AssembleContextInternalRequest,
  AfterTurnKernelRequest,
  HealthResponse,
  IngestMessageKernelRequest,
  RebuildIndexRequest,
  RebuildIndexResponse,
  RpcRequest,
  RpcResponse,
  SearchTextResponse,
} from "@xdarkicex/libravdb-contracts";
import {
  normalizeAssembleResult,
  normalizeKernelMessage,
  normalizeKernelMessages,
} from "../../src/context-engine.js";
import { RpcClient } from "../../src/rpc.js";
import type { SidecarSocket } from "../../src/types.js";

class FakeSocket implements SidecarSocket {
  private readonly dataHandlers: Array<(chunk: Buffer) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];
  private readonly errorHandlers: Array<(error: Error) => void> = [];
  private readonly connectOnce: Array<() => void> = [];
  private errorOnce: Array<(error: Error) => void> = [];
  public writes: Buffer[] = [];

  setEncoding(_encoding: string): void {}

  on(
    event: "data" | "close" | "error",
    handler: ((chunk: Buffer) => void) | (() => void) | ((error: Error) => void),
  ): void {
    if (event === "data") {
      this.dataHandlers.push(handler as (chunk: Buffer) => void);
    } else if (event === "error") {
      this.errorHandlers.push(handler as (error: Error) => void);
    } else {
      this.closeHandlers.push(handler as () => void);
    }
  }

  once(event: "connect" | "error", handler: (() => void) | ((error: Error) => void)): void {
    if (event === "connect") {
      this.connectOnce.push(handler as () => void);
    } else {
      this.errorOnce.push(handler as (error: Error) => void);
    }
  }

  off(event: "connect" | "error", handler: (() => void) | ((error: Error) => void)): void {
    if (event === "connect") {
      const idx = this.connectOnce.indexOf(handler as () => void);
      if (idx >= 0) this.connectOnce.splice(idx, 1);
      return;
    }
    const idx = this.errorOnce.indexOf(handler as (error: Error) => void);
    if (idx >= 0) this.errorOnce.splice(idx, 1);
  }

  write(chunk: Buffer | string): void {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  destroy(): void {
    for (const handler of this.closeHandlers) {
      handler();
    }
  }

  emitData(...chunks: Buffer[]): void {
    for (const chunk of chunks) {
      for (const handler of this.dataHandlers) {
        handler(chunk);
      }
    }
  }

  emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
    for (const handler of this.errorOnce) {
      handler(error);
    }
    this.errorOnce = [];
  }
}

class ReconnectingSocket extends FakeSocket {
  private available = false;
  private readonly reconnectHandlers: Array<() => void> = [];
  private reconnectErrorHandlers: Array<(error: Error) => void> = [];

  override once(event: "connect" | "error", handler: (() => void) | ((error: Error) => void)): void {
    if (event === "connect") {
      if (this.available) {
        (handler as () => void)();
        return;
      }
      this.reconnectHandlers.push(handler as () => void);
      return;
    }
    this.reconnectErrorHandlers.push(handler as (error: Error) => void);
  }

  override off(event: "connect" | "error", handler: (() => void) | ((error: Error) => void)): void {
    if (event === "connect") {
      const index = this.reconnectHandlers.indexOf(handler as () => void);
      if (index >= 0) this.reconnectHandlers.splice(index, 1);
      return;
    }
    const index = this.reconnectErrorHandlers.indexOf(handler as (error: Error) => void);
    if (index >= 0) this.reconnectErrorHandlers.splice(index, 1);
  }

  override write(chunk: Buffer | string): void {
    if (!this.available) {
      throw new Error("Sidecar socket unavailable");
    }
    super.write(chunk);
  }

  emitConnect(): void {
    this.available = true;
    for (const handler of this.reconnectHandlers.splice(0)) {
      handler();
    }
  }

  emitReconnectError(error: Error): void {
    for (const handler of this.reconnectErrorHandlers.splice(0)) {
      handler(error);
    }
  }

  emitClose(): void {
    this.available = false;
    super.destroy();
  }
}

function parseClientFrame(frame: Buffer): Buffer {
  const offset = frame[0] === 0x02 ? 1 : 0;
  const payloadLength = frame.readUInt32BE(offset);
  return frame.subarray(offset + 4, offset + 4 + payloadLength);
}

function frameServerPayload(payload: Uint8Array): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([header, Buffer.from(payload)]);
}

test("RpcClient sends and receives protobuf envelopes", async () => {
  const socket = new FakeSocket();
  const client = new RpcClient(socket, { timeoutMs: 100 });

  const pending = client.call<{ results: Array<{ metadata: Record<string, unknown> }> }>("search_text", {
    collection: "user:123",
    text: "needle",
    k: 2,
  });

  assert.equal(socket.writes.length, 1);
  const request = RpcRequest.fromBinary(parseClientFrame(socket.writes[0]!));
  assert.equal(request.method, "search_text");
  assert.equal(request.id, 1n);
  assert.ok(request.params.byteLength > 0);

  const response = new (RpcResponse as any)({
    id: request.id,
    result: SearchTextResponse.fromJson({
      results: [
        {
          id: "mem-1",
          score: 0.99,
          text: "needle hit",
          metadata: { collection: "user:123" },
        },
      ],
    }).toBinary(),
  });
  const responseFrame = frameServerPayload(response.toBinary());
  socket.emitData(responseFrame.subarray(0, 3), responseFrame.subarray(3));

  const result = await pending;
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.metadata.collection, "user:123");
});

test("RpcClient preserves empty result arrays and debug payloads", async () => {
  const socket = new FakeSocket();
  const client = new RpcClient(socket, { timeoutMs: 100 });

  const pending = client.call<{
    messages?: Array<{ role: string; content: string; id?: string }>;
    estimatedTokens?: number;
    systemPromptAddition?: string;
    debug?: unknown;
  }>("assemble_context_internal", {
    sessionId: "s1",
    sessionKey: "k1",
    userId: "u1",
    messages: [],
    tokenBudget: 0,
    prompt: "",
    emitDebug: true,
    config: {},
  });

  const request = RpcRequest.fromBinary(parseClientFrame(socket.writes[0]!));
  const response = new (RpcResponse as any)({
    id: request.id,
    result: AssembleContextInternalResponse.fromJson({
      messages: [],
      estimatedTokens: 12,
      systemPromptAddition: "sys",
      debug: { recoveryTriggerFired: false, crossSessionRawRecovery: false },
    }).toBinary(),
  });
  socket.emitData(frameServerPayload(response.toBinary()));

  const result = await pending;
  assert.ok(Array.isArray(result.messages), "messages should be preserved as an array");
  assert.deepEqual(result.messages, []);
  assert.equal(result.estimatedTokens, 12);
  assert.equal(result.systemPromptAddition, "sys");
  assert.ok(result.debug !== undefined, "debug payload should be preserved");
});

test("RpcClient waits for reconnect when the supervisor socket is temporarily unavailable", async () => {
  const socket = new ReconnectingSocket();
  const client = new RpcClient(socket, { timeoutMs: 100 });

  socket.emitConnect();
  const first = client.call<{ ok?: boolean }>("health", {});
  assert.equal(socket.writes.length, 1);
  let request = RpcRequest.fromBinary(parseClientFrame(socket.writes[0]!));
  let response = new (RpcResponse as any)({
    id: request.id,
    result: HealthResponse.fromJson({ ok: true }).toBinary(),
  });
  socket.emitData(frameServerPayload(response.toBinary()));
  assert.equal((await first).ok, true);

  socket.emitClose();

  const pending = client.call<{ ok?: boolean }>("health", {});

  assert.equal(socket.writes.length, 1);
  socket.emitConnect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.writes.length, 2);

  request = RpcRequest.fromBinary(parseClientFrame(socket.writes[1]!));
  assert.equal(socket.writes[1]![0], 0x02);
  response = new (RpcResponse as any)({
    id: request.id,
    result: HealthResponse.fromJson({ ok: true }).toBinary(),
  });
  socket.emitData(frameServerPayload(response.toBinary()));

  const result = await pending;
  assert.equal(result.ok, true);
});

test("RpcClient does not resend after the original call has already timed out", async () => {
  const socket = new ReconnectingSocket();
  const client = new RpcClient(socket, { timeoutMs: 20 });

  const pending = client.call<{ ok?: boolean }>("health", {});
  await assert.rejects(pending, /RPC timeout: health \(20ms\)/);

  socket.emitConnect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.writes.length, 0);
});

test("normalizeKernelMessages flattens rich message blocks before assemble encoding", () => {
  const richMessages = normalizeKernelMessages([
    {
      role: "user",
      content: [{ type: "text", text: "Reply with exactly: OK" }],
      id: "m1",
    },
  ] as Array<{ role: string; content: unknown; id?: string }>);

  const roundtrip = AssembleContextInternalRequest.fromBinary(
    new AssembleContextInternalRequest({
      sessionId: "s1",
      messages: richMessages,
      tokenBudget: 100,
      prompt: "ignored",
    }).toBinary(),
  );

  assert.equal(roundtrip.messages[0]?.content, "Reply with exactly: OK");
});

test("normalizeKernelMessage prevents object-string coercion in ingest and after-turn requests", () => {
  const richMessage = normalizeKernelMessage({
    role: "assistant",
    content: [
      { type: "text", text: "Done" },
      { type: "toolCall", name: "memory_search", arguments: { q: "needle" } },
    ],
    id: "m2",
  });

  const ingestRoundtrip = IngestMessageKernelRequest.fromBinary(
    new IngestMessageKernelRequest({
      sessionId: "s1",
      message: richMessage,
    }).toBinary(),
  );
  assert.equal(ingestRoundtrip.message?.content, 'Done\n[tool:memory_search] {"q":"needle"}');

  const afterTurnRoundtrip = AfterTurnKernelRequest.fromBinary(
    new AfterTurnKernelRequest({
      sessionId: "s1",
      messages: [richMessage],
    }).toBinary(),
  );
  assert.equal(afterTurnRoundtrip.messages[0]?.content, 'Done\n[tool:memory_search] {"q":"needle"}');
});

test("normalizeAssembleResult preserves kernel string messages for existing callers", () => {
  const normalized = normalizeAssembleResult({
    messages: [{ role: "assistant", content: "OK", id: "m1" }],
    estimatedTokens: 7,
    systemPromptAddition: "sys",
  });

  assert.deepEqual(normalized.messages, [
    {
      role: "assistant",
      content: "OK",
      id: "m1",
    },
  ]);
  assert.equal(normalized.estimatedTokens, 7);
  assert.equal(normalized.systemPromptAddition, "sys");
});

test("normalizeAssembleResult stringifies rich content blocks consistently", () => {
  const normalized = normalizeAssembleResult({
    messages: [{
      role: "assistant",
      content: [
        { type: "text", text: "Done" },
        { type: "toolCall", name: "memory_search", arguments: { q: "needle" } },
      ],
      id: "m-rich",
    }],
  });

  assert.deepEqual(normalized.messages, [
    {
      role: "assistant",
      content: 'Done\n[tool:memory_search] {"q":"needle"}',
      id: "m-rich",
    },
  ]);
});

test("normalizeAssembleResult coerces non-replay-safe roles to assistant string messages", () => {
  const normalized = normalizeAssembleResult({
    messages: [{ role: "toolResult", content: "tool output", id: "m2" }],
  });

  assert.deepEqual(normalized.messages, [
    {
      role: "assistant",
      content: "tool output",
      id: "m2",
    },
  ]);
});

test("normalizeAssembleResult omits null debug payloads", () => {
  const normalized = normalizeAssembleResult({
    messages: [],
    debug: null as any,
  });

  assert.equal("debug" in normalized, false);
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

test("RpcClient rejects pending calls on runtime socket error", async () => {
  const socket = new FakeSocket();
  const client = new RpcClient(socket, { timeoutMs: 100 });

  const pending = client.call("health", {});
  socket.emitError(new Error("ECONNRESET"));

  await assert.rejects(pending, /ECONNRESET/);
});

test("RpcClient supports per-call timeout overrides", async () => {
  const socket = new FakeSocket();
  const client = new RpcClient(socket, { timeoutMs: 100 });

  await assert.rejects(client.call("health", {}, { timeoutMs: 10 }), /10ms/);
});

test("rebuild_index round-trips through protobuf codec", async () => {
  const socket = new FakeSocket();
  const client = new RpcClient(socket, { timeoutMs: 100 });

  const pending = client.call<{
    collectionsProcessed: number;
    recordsReindexed: number;
    collectionsRecreated: number;
    errors: string[];
  }>("rebuild_index", {
    namespace: "test-user",
    collections: ["authored:hard", "authored:soft"],
  });

  assert.equal(socket.writes.length, 1);
  const request = RpcRequest.fromBinary(parseClientFrame(socket.writes[0]!));
  assert.equal(request.method, "rebuild_index");

  const decodedParams = RebuildIndexRequest.fromBinary(request.params);
  assert.equal(decodedParams.namespace, "test-user");
  assert.deepEqual(decodedParams.collections, ["authored:hard", "authored:soft"]);

  const response = new (RpcResponse as any)({
    id: request.id,
    result: RebuildIndexResponse.fromJson({
      collectionsProcessed: 3,
      recordsReindexed: 42,
      collectionsRecreated: 1,
      errors: [],
    }).toBinary(),
  });
  socket.emitData(frameServerPayload(response.toBinary()));

  const result = await pending;
  assert.equal(result.collectionsProcessed, 3);
  assert.equal(result.recordsReindexed, 42);
  assert.equal(result.collectionsRecreated, 1);
  assert.ok(result.errors === undefined || result.errors.length === 0);
});
