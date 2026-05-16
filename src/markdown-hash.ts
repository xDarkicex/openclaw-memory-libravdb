const WASM_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60,
  0x02, 0x7f, 0x7f, 0x01, 0x7e, 0x03, 0x02, 0x01, 0x00, 0x04, 0x05, 0x01,
  0x70, 0x01, 0x01, 0x01, 0x05, 0x03, 0x01, 0x00, 0x10, 0x06, 0x09, 0x01,
  0x7f, 0x01, 0x41, 0x80, 0x80, 0xc0, 0x00, 0x0b, 0x07, 0x19, 0x02, 0x06,
  0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x0c, 0x68, 0x61, 0x73,
  0x68, 0x5f, 0x66, 0x6e, 0x76, 0x31, 0x61, 0x36, 0x34, 0x00, 0x00, 0x0a,
  0x41, 0x01, 0x3f, 0x01, 0x01, 0x7e, 0x42, 0x83, 0x87, 0xf4, 0x9c, 0x87,
  0xf6, 0xc3, 0xb2, 0x14, 0x21, 0x02, 0x02, 0x40, 0x20, 0x01, 0x45, 0x0d,
  0x00, 0x03, 0x40, 0x20, 0x02, 0x20, 0x00, 0x31, 0x00, 0x00, 0x85, 0x42,
  0xb3, 0x83, 0x80, 0x80, 0x80, 0x20, 0x7e, 0x21, 0x02, 0x20, 0x00, 0x41,
  0x01, 0x6a, 0x21, 0x00, 0x20, 0x01, 0x41, 0x7f, 0x6a, 0x22, 0x01, 0x0d,
  0x00, 0x0b, 0x0b, 0x20, 0x02, 0x0b,
]);

const textEncoder = new TextEncoder();
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

interface HashBackend {
  kind: string;
  hash(bytes: Uint8Array): string;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  hash_fnv1a64(ptr: number, len: number): bigint;
}

class Fnv64Fallback implements HashBackend {
  kind = "js-fnv1a64";

  hash(bytes: Uint8Array): string {
    let hash = FNV_OFFSET_BASIS;
    for (let i = 0; i < bytes.length; i++) {
      hash ^= BigInt(bytes[i] ?? 0);
      hash = BigInt.asUintN(64, hash * FNV_PRIME);
    }
    return hash.toString(16).padStart(16, "0");
  }
}

class WasmFnv64 implements HashBackend {
  kind = "wasm-fnv1a64";
  private readonly memory: WebAssembly.Memory;
  private readonly hashFn: (ptr: number, len: number) => bigint;
  private view: Uint8Array;

  constructor() {
    const module = new WebAssembly.Module(WASM_BYTES);
    const instance = new WebAssembly.Instance(module, {});
    const exports = instance.exports as unknown as WasmExports;
    this.memory = exports.memory;
    this.hashFn = exports.hash_fnv1a64;
    this.view = new Uint8Array(this.memory.buffer);
  }

  hash(bytes: Uint8Array): string {
    this.ensureCapacity(bytes.length);
    this.view.set(bytes, 0);
    const raw = this.hashFn(0, bytes.length);
    return BigInt.asUintN(64, raw).toString(16).padStart(16, "0");
  }

  private ensureCapacity(size: number): void {
    if (this.view.byteLength >= size) {
      return;
    }

    const WASM_PAGE_SIZE = 65536;
    const requiredPages = Math.ceil(size / WASM_PAGE_SIZE);
    const currentPages = this.memory.buffer.byteLength / WASM_PAGE_SIZE;
    const deltaPages = requiredPages - currentPages;
    if (deltaPages > 0) {
      this.memory.grow(deltaPages);
      this.view = new Uint8Array(this.memory.buffer);
    }
  }
}

let backend: HashBackend | null = null;

function getBackend(): HashBackend {
  if (!backend) {
    try {
      backend = new WasmFnv64();
    } catch {
      backend = new Fnv64Fallback();
    }
  }
  return backend;
}

export function hashBytes(bytes: Uint8Array): string {
  return getBackend().hash(bytes);
}

export function hashText(text: string): string {
  return hashBytes(textEncoder.encode(text));
}

export function getHashBackendName(): string {
  return getBackend().kind;
}
