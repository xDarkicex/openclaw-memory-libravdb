#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT_DIR/.sidecar-bin"
BIN_NAME="libravdb-sidecar"
MODELS_DIR="$ROOT_DIR/.models"
OUT_MODELS_DIR="$OUT_DIR/models"
OUT_RUNTIME_DIR="$OUT_DIR/onnxruntime"

if [[ "${OS:-}" == "Windows_NT" ]]; then
  BIN_NAME="libravdb-sidecar.exe"
fi

mkdir -p "$OUT_DIR"
cd "$ROOT_DIR/sidecar"
GOCACHE="${GOCACHE:-/tmp/openclaw-memory-libravdb-gocache}" go build -o "$OUT_DIR/$BIN_NAME" .
rm -rf "$OUT_MODELS_DIR" "$OUT_RUNTIME_DIR"
mkdir -p "$OUT_MODELS_DIR"
if [[ -d "$MODELS_DIR/all-minilm-l6-v2" ]]; then
  cp -R "$MODELS_DIR/all-minilm-l6-v2" "$OUT_MODELS_DIR/all-minilm-l6-v2"
fi
if [[ -d "$MODELS_DIR/nomic-embed-text-v1.5" ]]; then
  cp -R "$MODELS_DIR/nomic-embed-text-v1.5" "$OUT_MODELS_DIR/nomic-embed-text-v1.5"
fi
if [[ -d "$MODELS_DIR/onnxruntime" ]]; then
  mkdir -p "$OUT_RUNTIME_DIR"
  cp -R "$MODELS_DIR/onnxruntime/." "$OUT_RUNTIME_DIR/"
fi
echo "built sidecar: $OUT_DIR/$BIN_NAME"
