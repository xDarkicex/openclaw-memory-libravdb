#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODELS_DIR="$ROOT_DIR/.models"
ORT_ARCHIVE="$MODELS_DIR/onnxruntime/onnxruntime-osx-arm64-1.23.0.tgz"
ORT_LIB="$MODELS_DIR/onnxruntime/onnxruntime-osx-arm64-1.23.0/lib/libonnxruntime.dylib"

if [[ ! -f "$ORT_ARCHIVE" ]]; then
  echo "ONNX Runtime archive not found: $ORT_ARCHIVE" >&2
  exit 1
fi

if [[ ! -f "$ORT_LIB" ]]; then
  echo "Unpacking ONNX Runtime..."
  tar -xzf "$ORT_ARCHIVE" -C "$MODELS_DIR/onnxruntime/"
  echo "Done: $ORT_LIB"
else
  echo "ONNX Runtime already unpacked."
fi
