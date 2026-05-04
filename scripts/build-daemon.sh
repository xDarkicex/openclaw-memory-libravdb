#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT_DIR/.daemon-bin"
BIN_NAME="libravdbd"
MODELS_DIR="$ROOT_DIR/.models"
OUT_MODELS_DIR="$OUT_DIR/models"
OUT_RUNTIME_DIR="$OUT_DIR/onnxruntime"
SOURCE_DIR="${LIBRAVDBD_SOURCE_DIR:-}"
SOURCE_BIN="${LIBRAVDBD_BINARY_PATH:-}"

if [[ "${OS:-}" == "Windows_NT" ]]; then
  BIN_NAME="libravdbd.exe"
fi

copy_assets() {
  local asset_root="$1"
  if [[ -d "$asset_root/bge-small-en-v1.5" ]]; then
    rm -rf "$OUT_MODELS_DIR/bge-small-en-v1.5"
    cp -R "$asset_root/bge-small-en-v1.5" "$OUT_MODELS_DIR/bge-small-en-v1.5"
  fi
  if [[ -d "$asset_root/nomic-embed-text-v1.5" ]]; then
    rm -rf "$OUT_MODELS_DIR/nomic-embed-text-v1.5"
    cp -R "$asset_root/nomic-embed-text-v1.5" "$OUT_MODELS_DIR/nomic-embed-text-v1.5"
  fi
  if [[ -d "$asset_root/t5-small" ]]; then
    rm -rf "$OUT_MODELS_DIR/t5-small"
    cp -R "$asset_root/t5-small" "$OUT_MODELS_DIR/t5-small"
  fi
  if [[ -d "$asset_root/onnxruntime" ]]; then
    mkdir -p "$OUT_RUNTIME_DIR"
    cp -R "$asset_root/onnxruntime/." "$OUT_RUNTIME_DIR/"
  fi
}

mkdir -p "$OUT_DIR"

if [[ -n "$SOURCE_BIN" ]]; then
  cp "$SOURCE_BIN" "$OUT_DIR/$BIN_NAME"
elif [[ -n "$SOURCE_DIR" ]]; then
  (
    cd "$SOURCE_DIR"
    GOCACHE="${GOCACHE:-/tmp/openclaw-memory-libravdb-gocache}" go build -o "$OUT_DIR/$BIN_NAME" .
  )
elif command -v "$BIN_NAME" >/dev/null 2>&1; then
  cp "$(command -v "$BIN_NAME")" "$OUT_DIR/$BIN_NAME"
else
  cat >&2 <<EOF
Unable to prepare $BIN_NAME.

Use one of:
  LIBRAVDBD_SOURCE_DIR=/path/to/libravdbd bash scripts/build-daemon.sh
  LIBRAVDBD_BINARY_PATH=/path/to/$BIN_NAME bash scripts/build-daemon.sh
  brew install libravdbd
EOF
  exit 1
fi

if [[ "${OS:-}" != "Windows_NT" ]]; then
  chmod +x "$OUT_DIR/$BIN_NAME"
fi

rm -rf "$OUT_MODELS_DIR" "$OUT_RUNTIME_DIR"
mkdir -p "$OUT_MODELS_DIR"
if [[ -d "$MODELS_DIR" ]]; then
  copy_assets "$MODELS_DIR"
elif [[ -n "$SOURCE_DIR" && -d "$SOURCE_DIR/.models" ]]; then
  copy_assets "$SOURCE_DIR/.models"
fi
echo "built daemon: $OUT_DIR/$BIN_NAME"
