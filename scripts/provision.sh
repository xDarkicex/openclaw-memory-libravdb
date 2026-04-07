#!/usr/bin/env bash
# provision.sh — Standalone provisioner for libravdbd runtime assets.
#
# Downloads and verifies the ONNX runtime library and embedding/summarizer
# models required by libravdbd.  Designed to run on macOS (arm64/amd64)
# and Linux (x64/arm64); Windows is not supported by this script.
#
# The script is idempotent: existing assets that pass SHA-256 verification
# are left in place.
#
# Usage:
#   bash scripts/provision.sh [--target DIR] [--skip-summarizer] [--help]
#
# Options:
#   --target DIR         Base directory for the .daemon-bin tree.
#                        Defaults to <script-dir>/../.daemon-bin
#   --skip-summarizer    Skip the optional t5-small summarizer model.
#   --help               Print this message and exit.
#
# The resulting directory layout:
#
#   <target>/
#     models/
#       nomic-embed-text-v1.5/
#         model.onnx
#         tokenizer.json
#         embedding.json
#       all-minilm-l6-v2/
#         model.onnx
#         tokenizer.json
#         embedding.json
#       t5-small/               (optional)
#         encoder_model.onnx
#         decoder_model.onnx
#         tokenizer.json
#         tokenizer_config.json
#         config.json
#         summarizer.json
#     onnxruntime/
#       onnxruntime-<platform>/
#         lib/
#           libonnxruntime.dylib  (macOS)
#           libonnxruntime.so     (Linux)

set -euo pipefail

# ── Helpers ───────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { printf "${CYAN}[provision]${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}[provision]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[provision]${NC} %s\n" "$*" >&2; }
die()   { printf "${RED}[provision]${NC} %s\n" "$*" >&2; exit 1; }

# ── Argument parsing ──────────────────────────────────────────────────

TARGET_DIR="${ROOT_DIR}/.daemon-bin"
SKIP_SUMMARIZER=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ $# -ge 2 && "$2" != --* ]] || die "Missing argument for --target"
      TARGET_DIR="$2"; shift 2 ;;
    --skip-summarizer)
      SKIP_SUMMARIZER=1; shift ;;
    --help|-h)
      sed -n '2,/^$/{ s/^# //; s/^#//; p; }' "$0"
      exit 0 ;;
    *)
      die "Unknown option: $1.  Use --help for usage." ;;
  esac
done

MODELS_DIR="${TARGET_DIR}/models"
RUNTIME_DIR="${TARGET_DIR}/onnxruntime"

# ── Platform detection ────────────────────────────────────────────────

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *)      die "Unsupported OS: $os" ;;
  esac
  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64)        arch="amd64" ;;
    *)             die "Unsupported architecture: $arch" ;;
  esac
  echo "${os}-${arch}"
}

PLATFORM="$(detect_platform)"
info "Platform: ${PLATFORM}"

# ── SHA-256 verification ─────────────────────────────────────────────

verify_sha256() {
  local file="$1" expected="$2"
  [[ -f "$file" ]] || return 1
  [[ -z "$expected" ]] && return 0
  local actual
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  else
    die "Neither shasum nor sha256sum found on PATH"
  fi
  [[ "$actual" == "$expected" ]]
}

# ── Download helper ───────────────────────────────────────────────────

download() {
  local url="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  local tmp="${dest}.tmp.$$"
  if command -v curl >/dev/null 2>&1; then
    curl -fSL --retry 3 --progress-bar -o "$tmp" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress -O "$tmp" "$url"
  else
    die "Neither curl nor wget found on PATH"
  fi
  mv -f "$tmp" "$dest"
}

# ── Asset provisioning ───────────────────────────────────────────────

ensure_asset() {
  local name="$1" url="$2" dest="$3" sha256="${4:-}" optional="${5:-}"
  if verify_sha256 "$dest" "$sha256"; then
    ok "  ✓ ${name} (cached)"
    return 0
  fi
  info "  ↓ Downloading ${name}…"
  download "$url" "$dest"
  if [[ -n "$sha256" ]] && ! verify_sha256 "$dest" "$sha256"; then
    rm -f "$dest"
    if [[ "$optional" == "optional" ]]; then
      warn "  SHA-256 verification failed for ${name} (skipping optional asset)"
      return 1
    fi
    die "SHA-256 verification failed for ${name}"
  fi
  ok "  ✓ ${name}"
}

# ── Model manifest writers ───────────────────────────────────────────

write_nomic_manifest() {
  local dir="${MODELS_DIR}/nomic-embed-text-v1.5"
  mkdir -p "$dir"
  cat > "${dir}/embedding.json" <<'MANIFEST'
{
  "backend": "onnx-local",
  "profile": "nomic-embed-text-v1.5",
  "family": "nomic-embed-text-v1.5",
  "model": "model.onnx",
  "tokenizer": "tokenizer.json",
  "dimensions": 768,
  "normalize": true,
  "inputNames": ["input_ids", "attention_mask", "token_type_ids"],
  "outputName": "last_hidden_state",
  "pooling": "mean",
  "addSpecialTokens": true
}
MANIFEST
}

write_minilm_manifest() {
  local dir="${MODELS_DIR}/all-minilm-l6-v2"
  mkdir -p "$dir"
  cat > "${dir}/embedding.json" <<'MANIFEST'
{
  "backend": "onnx-local",
  "profile": "all-minilm-l6-v2",
  "family": "all-minilm-l6-v2",
  "model": "model.onnx",
  "tokenizer": "tokenizer.json",
  "dimensions": 384,
  "normalize": true,
  "inputNames": ["input_ids", "attention_mask", "token_type_ids"],
  "outputName": "last_hidden_state",
  "pooling": "mean",
  "addSpecialTokens": true
}
MANIFEST
}

write_summarizer_manifest() {
  local dir="${MODELS_DIR}/t5-small"
  mkdir -p "$dir"
  cat > "${dir}/summarizer.json" <<'MANIFEST'
{
  "backend": "onnx-local",
  "profile": "t5-small",
  "family": "t5-small",
  "encoder": "encoder_model.onnx",
  "decoder": "decoder_model.onnx",
  "tokenizer": "tokenizer.json",
  "maxContextTokens": 512
}
MANIFEST
}

# ── ONNX Runtime ──────────────────────────────────────────────────────

ONNXRUNTIME_VERSION="1.23.0"

declare -A RUNTIME_ARCHIVE RUNTIME_URL RUNTIME_SHA256 RUNTIME_LIB

RUNTIME_ARCHIVE[darwin-arm64]="onnxruntime-osx-arm64-${ONNXRUNTIME_VERSION}.tgz"
RUNTIME_URL[darwin-arm64]="https://github.com/microsoft/onnxruntime/releases/download/v${ONNXRUNTIME_VERSION}/onnxruntime-osx-arm64-${ONNXRUNTIME_VERSION}.tgz"
RUNTIME_SHA256[darwin-arm64]="8182db0ebb5caa21036a3c78178f17fabb98a7916bdab454467c8f4cf34bcfdf"
RUNTIME_LIB[darwin-arm64]="onnxruntime-osx-arm64-${ONNXRUNTIME_VERSION}/lib/libonnxruntime.dylib"

RUNTIME_ARCHIVE[darwin-amd64]="onnxruntime-osx-x86_64-${ONNXRUNTIME_VERSION}.tgz"
RUNTIME_URL[darwin-amd64]="https://github.com/microsoft/onnxruntime/releases/download/v${ONNXRUNTIME_VERSION}/onnxruntime-osx-x86_64-${ONNXRUNTIME_VERSION}.tgz"
RUNTIME_SHA256[darwin-amd64]=""
RUNTIME_LIB[darwin-amd64]="onnxruntime-osx-x86_64-${ONNXRUNTIME_VERSION}/lib/libonnxruntime.dylib"

RUNTIME_ARCHIVE[linux-amd64]="onnxruntime-linux-x64-${ONNXRUNTIME_VERSION}.tgz"
RUNTIME_URL[linux-amd64]="https://github.com/microsoft/onnxruntime/releases/download/v${ONNXRUNTIME_VERSION}/onnxruntime-linux-x64-${ONNXRUNTIME_VERSION}.tgz"
RUNTIME_SHA256[linux-amd64]=""
RUNTIME_LIB[linux-amd64]="onnxruntime-linux-x64-${ONNXRUNTIME_VERSION}/lib/libonnxruntime.so"

RUNTIME_ARCHIVE[linux-arm64]="onnxruntime-linux-aarch64-${ONNXRUNTIME_VERSION}.tgz"
RUNTIME_URL[linux-arm64]="https://github.com/microsoft/onnxruntime/releases/download/v${ONNXRUNTIME_VERSION}/onnxruntime-linux-aarch64-${ONNXRUNTIME_VERSION}.tgz"
RUNTIME_SHA256[linux-arm64]=""
RUNTIME_LIB[linux-arm64]="onnxruntime-linux-aarch64-${ONNXRUNTIME_VERSION}/lib/libonnxruntime.so"

provision_runtime() {
  local archive_name="${RUNTIME_ARCHIVE[$PLATFORM]}"
  local url="${RUNTIME_URL[$PLATFORM]}"
  local sha256="${RUNTIME_SHA256[$PLATFORM]}"
  local lib_rel="${RUNTIME_LIB[$PLATFORM]}"

  if [[ -z "$archive_name" ]]; then
    die "No ONNX runtime spec for platform ${PLATFORM}"
  fi

  local lib_path="${RUNTIME_DIR}/${lib_rel}"
  if [[ -f "$lib_path" ]]; then
    ok "ONNX runtime already present"
    return 0
  fi

  info "Provisioning ONNX runtime for ${PLATFORM}…"
  mkdir -p "$RUNTIME_DIR"
  local archive_path="${RUNTIME_DIR}/${archive_name}"

  if ! verify_sha256 "$archive_path" "$sha256"; then
    download "$url" "$archive_path"
    if [[ -n "$sha256" ]] && ! verify_sha256 "$archive_path" "$sha256"; then
      rm -f "$archive_path"
      die "SHA-256 verification failed for ONNX runtime archive"
    fi
  fi

  info "Extracting ONNX runtime…"
  tar -xzf "$archive_path" -C "$RUNTIME_DIR"

  if [[ ! -f "$lib_path" ]]; then
    die "Runtime archive extracted but library missing: ${lib_path}"
  fi

  # Clean up archive to save disk space
  rm -f "$archive_path"
  ok "ONNX runtime ready"
}

# ── Main ──────────────────────────────────────────────────────────────

main() {
  info "Target directory: ${TARGET_DIR}"
  mkdir -p "$MODELS_DIR" "$RUNTIME_DIR"

  # ── Nomic Embed Text v1.5 (primary embedder) ──
  info "Provisioning nomic-embed-text-v1.5…"
  ensure_asset \
    "nomic-embed-text-v1.5 model" \
    "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/onnx/model.onnx" \
    "${MODELS_DIR}/nomic-embed-text-v1.5/model.onnx" \
    "147d5aa88c2101237358e17796cf3a227cead1ec304ec34b465bb08e9d952965"

  ensure_asset \
    "nomic-embed-text-v1.5 tokenizer" \
    "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/tokenizer.json" \
    "${MODELS_DIR}/nomic-embed-text-v1.5/tokenizer.json" \
    "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66"

  write_nomic_manifest

  # ── All-MiniLM-L6-v2 (fallback embedder) ──
  info "Provisioning all-minilm-l6-v2…"
  ensure_asset \
    "all-minilm-l6-v2 model" \
    "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx" \
    "${MODELS_DIR}/all-minilm-l6-v2/model.onnx" \
    "6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452"

  ensure_asset \
    "all-minilm-l6-v2 tokenizer" \
    "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json" \
    "${MODELS_DIR}/all-minilm-l6-v2/tokenizer.json" \
    "be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037"

  write_minilm_manifest

  # ── ONNX Runtime ──
  provision_runtime

  # ── T5-Small Summarizer (optional) ──
  if [[ "$SKIP_SUMMARIZER" -eq 0 ]]; then
    info "Provisioning t5-small summarizer (optional)…"
    local t5_ok=1

    ensure_asset \
      "t5-small encoder" \
      "https://huggingface.co/optimum/t5-small/resolve/main/encoder_model.onnx" \
      "${MODELS_DIR}/t5-small/encoder_model.onnx" \
      "41d326633f1b85f526508cc0db78a5d40877c292c1b6dccae2eacd7d2a53480d" \
      "optional" \
      || t5_ok=0

    if [[ "$t5_ok" -eq 1 ]]; then
      ensure_asset \
        "t5-small decoder" \
        "https://huggingface.co/optimum/t5-small/resolve/main/decoder_model.onnx" \
        "${MODELS_DIR}/t5-small/decoder_model.onnx" \
        "0a1451011d61bcc796a87b7306c503562e910f110f884d0cc08532972c2cc584" \
        "optional" \
        || t5_ok=0
    fi

    if [[ "$t5_ok" -eq 1 ]]; then
      ensure_asset \
        "t5-small tokenizer" \
        "https://huggingface.co/optimum/t5-small/resolve/main/tokenizer.json" \
        "${MODELS_DIR}/t5-small/tokenizer.json" \
        "5f0ed8ab5b8cfa9812bb73752f1d80c292e52bcf5a87a144dc9ab2d251056cbb" \
        "optional" \
        || t5_ok=0
    fi

    if [[ "$t5_ok" -eq 1 ]]; then
      ensure_asset \
        "t5-small tokenizer config" \
        "https://huggingface.co/optimum/t5-small/resolve/main/tokenizer_config.json" \
        "${MODELS_DIR}/t5-small/tokenizer_config.json" \
        "4969f8d76ef05a16553bd2b07b3501673ae8d36972aea88a0f78ad31a3ff2de9" \
        "optional" \
        || t5_ok=0
    fi

    if [[ "$t5_ok" -eq 1 ]]; then
      ensure_asset \
        "t5-small config" \
        "https://huggingface.co/optimum/t5-small/resolve/main/config.json" \
        "${MODELS_DIR}/t5-small/config.json" \
        "d112428e703aa7ea0d6b17a77e9739fcc15b87653779d9b7942d5ecbc61c00ed" \
        "optional" \
        || t5_ok=0
    fi

    if [[ "$t5_ok" -eq 1 ]]; then
      write_summarizer_manifest
      ok "t5-small summarizer ready"
    else
      warn "Summarizer provisioning skipped (optional asset download failed)"
    fi
  else
    info "Skipping summarizer (--skip-summarizer)"
  fi

  echo ""
  ok "Provisioning complete.  Asset directory: ${TARGET_DIR}"
  ok "Models and ONNX runtime are ready in: ${TARGET_DIR}"
}

main "$@"
