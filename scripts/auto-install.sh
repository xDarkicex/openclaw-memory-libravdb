#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------
# LibraVDB Memory Installer (libravdbd + OpenClaw plugin)
# ------------------------------------------------------------

REPO_OWNER_LOWER="xdarkicex"
PLUGIN_REPO="openclaw-memory-libravdb"
TAP_REPO="homebrew-openclaw-libravdb-memory"
PLUGIN_ID="libravdb-memory"
PLUGIN_PACKAGE="@${REPO_OWNER_LOWER}/${PLUGIN_REPO}"
DAEMON_RELEASE_BASE="https://github.com/${REPO_OWNER_LOWER}/${TAP_REPO}/releases/download"
OPENCLAW_MIN_VERSION="2026.3.22"
INSTALLER_VERSION="1.2.0"
ONNXRUNTIME_VERSION="1.25.1"

ASSUME_YES=0
DRY_RUN=0
DEBUG_MODE=0
UNINSTALL_MODE=0
DOWNLOADED_BIN_PATH=""
LAST_CONFIG_BACKUP=""
TMP_FILES=()

if [[ -t 1 ]]; then
  RED=$(printf '\033[0;31m')
  GREEN=$(printf '\033[0;32m')
  YELLOW=$(printf '\033[0;33m')
  BOLD=$(printf '\033[1m')
  RESET=$(printf '\033[0m')
else
  RED=""
  GREEN=""
  YELLOW=""
  BOLD=""
  RESET=""
fi

info()  { echo -e "${GREEN}==>${RESET} $*"; }
warn()  { echo -e "${YELLOW}==>${RESET} $*"; }
error() { echo -e "${RED}error:${RESET} $*" >&2; }
die()   { error "$*"; exit 1; }

usage() {
  cat <<EOF
Usage: $(basename "$0") [--yes] [--dry-run] [--debug] [--uninstall]

Options:
  --yes      Run non-interactively and accept all confirmations.
  --dry-run  Print planned actions without changing the system.
  --debug    Enable shell trace output (set -x) for troubleshooting.
  --uninstall Remove installer-managed plugin/daemon integration (safe scaffold).
  -h, --help Show this help.
EOF
}

confirm() {
  local prompt="$1"
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    warn "No interactive stdin detected; auto-accepting: ${prompt}"
    return 0
  fi
  read -r -p "$prompt [Y/n] " answer
  case "${answer:-Y}" in
    [Yy]|[Yy][Ee][Ss]) return 0 ;;
    [Nn]|[Nn][Oo]) return 1 ;;
    *) return 0 ;;
  esac
}

check_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "Required command '$1' not found. Please install $2 and re-run."
  fi
}

version_ge() {
  local left="$1"
  local right="$2"
  local IFS=.
  local -a lparts rparts
  local i l r
  read -r -a lparts <<< "$left"
  read -r -a rparts <<< "$right"
  for i in 0 1 2; do
    # Force base-10 to avoid bash octal parsing on zero-padded fields (e.g. 03).
    l=$((10#${lparts[$i]:-0}))
    r=$((10#${rparts[$i]:-0}))
    if (( l > r )); then
      return 0
    fi
    if (( l < r )); then
      return 1
    fi
  done
  return 0
}

detect_os() {
  case "$(uname -s)" in
    Darwin*) echo "darwin" ;;
    Linux*) echo "linux" ;;
    *) die "Unsupported OS: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    arm64|aarch64) echo "arm64" ;;
    *) die "Unsupported architecture: $(uname -m)" ;;
  esac
}

daemon_asset_name() {
  local os="$1"
  local arch="$2"
  case "${os}-${arch}" in
    darwin-arm64) echo "libravdbd-darwin-arm64" ;;
    darwin-amd64) echo "libravdbd-darwin-amd64" ;;
    linux-amd64) echo "libravdbd-linux-amd64" ;;
    linux-arm64) echo "libravdbd-linux-arm64" ;;
    *) return 1 ;;
  esac
}

onnxruntime_archive_name() {
  local os="$1"
  local arch="$2"
  case "${os}-${arch}" in
    darwin-arm64) echo "onnxruntime-osx-arm64-${ONNXRUNTIME_VERSION}.tgz" ;;
    darwin-amd64) echo "onnxruntime-osx-x86_64-${ONNXRUNTIME_VERSION}.tgz" ;;
    linux-amd64) echo "onnxruntime-linux-x64-${ONNXRUNTIME_VERSION}.tgz" ;;
    linux-arm64) echo "onnxruntime-linux-aarch64-${ONNXRUNTIME_VERSION}.tgz" ;;
    *) return 1 ;;
  esac
}

onnxruntime_extract_dir() {
  local os="$1"
  local arch="$2"
  case "${os}-${arch}" in
    darwin-arm64) echo "onnxruntime-osx-arm64-${ONNXRUNTIME_VERSION}" ;;
    darwin-amd64) echo "onnxruntime-osx-x86_64-${ONNXRUNTIME_VERSION}" ;;
    linux-amd64) echo "onnxruntime-linux-x64-${ONNXRUNTIME_VERSION}" ;;
    linux-arm64) echo "onnxruntime-linux-aarch64-${ONNXRUNTIME_VERSION}" ;;
    *) return 1 ;;
  esac
}

onnxruntime_sha256() {
  local os="$1"
  local arch="$2"
  case "${os}-${arch}" in
    darwin-arm64) echo "18987ec3187b5f29ba798109750f6135060560ad4e0a52678fcc753ee8fb3091" ;;
    darwin-amd64) echo "0019dfc4b32d63c1392aa264aed2253c1e0c2fb09216f8e2cc269bbfb8bb49b5" ;;
    linux-amd64) echo "eb566a49cfc49ef0642f809b69340b5bb656c7c4905ba873526d226f2c005816" ;;
    linux-arm64) echo "daa71b56b00c4ab34798a3d96ca41a32ece4d3e302dc2386d3cca83fd4491214" ;;
    *) return 1 ;;
  esac
}

onnxruntime_url() {
  local os="$1"
  local arch="$2"
  local archive
  archive="$(onnxruntime_archive_name "$os" "$arch")" || return 1
  echo "https://github.com/microsoft/onnxruntime/releases/download/v${ONNXRUNTIME_VERSION}/${archive}"
}

manual_asset_root() {
  echo "$HOME/.local/share/libravdb"
}

manual_models_dir() {
  echo "$(manual_asset_root)/models"
}

manual_runtime_dir() {
  echo "$(manual_asset_root)/onnxruntime"
}

manual_runtime_lib_path() {
  local os="$1"
  local arch="$2"
  local lib_name="libonnxruntime.so"
  if [[ "$os" == "darwin" ]]; then
    lib_name="libonnxruntime.dylib"
  fi
  echo "$(manual_runtime_dir)/$(onnxruntime_extract_dir "$os" "$arch")/lib/${lib_name}"
}

daemon_version() {
  local bin="${1:-libravdbd}"
  "$bin" version 2>/dev/null | head -1 || echo unknown
}

latest_release_tag() {
  local api_url="https://api.github.com/repos/${REPO_OWNER_LOWER}/${TAP_REPO}/releases/latest"
  local had_xtrace=0
  local response
  local header_file

  # Prevent token leakage when --debug (set -x) is enabled.
  case "$-" in
    *x*)
      had_xtrace=1
      set +x
      ;;
  esac

  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    header_file="$(mktemp)"
    TMP_FILES+=("$header_file")
    chmod 600 "$header_file"
    printf 'Authorization: Bearer %s\n' "${GITHUB_TOKEN}" > "$header_file"
    if ! response="$(curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 30 \
      -H "Accept: application/vnd.github+json" \
      -H "@${header_file}" \
      "$api_url")"; then
      [[ "$had_xtrace" -eq 1 ]] && set -x
      return 1
    fi
  else
    if ! response="$(curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 30 \
      -H "Accept: application/vnd.github+json" \
      "$api_url")"; then
      [[ "$had_xtrace" -eq 1 ]] && set -x
      return 1
    fi
  fi

  if [[ "$had_xtrace" -eq 1 ]]; then
    set -x
  fi
  printf '%s' "$response" | jq -re '.tag_name'
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return 0
  fi
  die "No SHA-256 tool found (need sha256sum or shasum)."
}

verify_sha256() {
  local file="$1"
  local expected="$2"
  local actual
  [[ -f "$file" ]] || return 1
  actual="$(sha256_file "$file")"
  [[ "$actual" == "$expected" ]]
}

download_verified_asset() {
  local name="$1"
  local url="$2"
  local dest="$3"
  local expected_sha="$4"
  local tmp

  mkdir -p "$(dirname "$dest")"
  if verify_sha256 "$dest" "$expected_sha"; then
    info "${name} already present."
    return 0
  fi

  info "Downloading ${name}"
  tmp="${dest}.tmp.$$"
  TMP_FILES+=("$tmp")
  curl -fL --retry 3 --retry-delay 1 --connect-timeout 10 --max-time 600 --progress-bar -o "$tmp" "$url"
  if ! verify_sha256 "$tmp" "$expected_sha"; then
    rm -f "$tmp"
    die "Checksum mismatch for ${name}."
  fi
  mv -f "$tmp" "$dest"
}

write_embedding_manifest() {
  local dir="$1"
  local profile="$2"
  local dimensions="$3"
  mkdir -p "$dir"
  cat > "$dir/embedding.json" <<EOF
{
  "backend": "onnx-local",
  "profile": "${profile}",
  "family": "${profile}",
  "model": "model.onnx",
  "tokenizer": "tokenizer.json",
  "dimensions": ${dimensions},
  "normalize": true,
  "inputNames": ["input_ids", "attention_mask", "token_type_ids"],
  "outputName": "last_hidden_state",
  "pooling": "mean",
  "addSpecialTokens": true
}
EOF
}

write_summarizer_manifest() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/summarizer.json" <<'EOF'
{
  "backend": "onnx-local",
  "profile": "t5-small",
  "family": "t5-small",
  "encoder": "encoder_model.onnx",
  "decoder": "decoder_model.onnx",
  "tokenizer": "tokenizer.json",
  "maxContextTokens": 512
}
EOF
}

provision_manual_assets() {
  local os="$1"
  local arch="$2"
  local models_dir runtime_dir runtime_archive runtime_lib runtime_url runtime_sha
  local nomic_dir bge_dir t5_dir

  models_dir="$(manual_models_dir)"
  runtime_dir="$(manual_runtime_dir)"
  runtime_archive="${runtime_dir}/$(onnxruntime_archive_name "$os" "$arch")"
  runtime_lib="$(manual_runtime_lib_path "$os" "$arch")"
  runtime_url="$(onnxruntime_url "$os" "$arch")"
  runtime_sha="$(onnxruntime_sha256 "$os" "$arch")"
  nomic_dir="${models_dir}/nomic-embed-text-v1.5"
  bge_dir="${models_dir}/bge-small-en-v1.5"
  t5_dir="${models_dir}/t5-small"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] provision ONNX Runtime and model assets under $(manual_asset_root)"
    return 0
  fi

  mkdir -p "$nomic_dir" "$bge_dir" "$t5_dir" "$runtime_dir"

  download_verified_asset \
    "nomic-embed-text-v1.5 model" \
    "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/onnx/model.onnx" \
    "${nomic_dir}/model.onnx" \
    "147d5aa88c2101237358e17796cf3a227cead1ec304ec34b465bb08e9d952965"
  download_verified_asset \
    "nomic-embed-text-v1.5 tokenizer" \
    "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/tokenizer.json" \
    "${nomic_dir}/tokenizer.json" \
    "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66"
  write_embedding_manifest "$nomic_dir" "nomic-embed-text-v1.5" "768"

  download_verified_asset \
    "bge-small-en-v1.5 model" \
    "https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/onnx/model.onnx" \
    "${bge_dir}/model.onnx" \
    "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35"
  download_verified_asset \
    "bge-small-en-v1.5 tokenizer" \
    "https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/tokenizer.json" \
    "${bge_dir}/tokenizer.json" \
    "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66"
  write_embedding_manifest "$bge_dir" "bge-small-en-v1.5" "384"

  download_verified_asset \
    "t5-small encoder" \
    "https://huggingface.co/optimum/t5-small/resolve/main/encoder_model.onnx" \
    "${t5_dir}/encoder_model.onnx" \
    "41d326633f1b85f526508cc0db78a5d40877c292c1b6dccae2eacd7d2a53480d"
  download_verified_asset \
    "t5-small decoder" \
    "https://huggingface.co/optimum/t5-small/resolve/main/decoder_model.onnx" \
    "${t5_dir}/decoder_model.onnx" \
    "0a1451011d61bcc796a87b7306c503562e910f110f884d0cc08532972c2cc584"
  download_verified_asset \
    "t5-small tokenizer" \
    "https://huggingface.co/optimum/t5-small/resolve/main/tokenizer.json" \
    "${t5_dir}/tokenizer.json" \
    "5f0ed8ab5b8cfa9812bb73752f1d80c292e52bcf5a87a144dc9ab2d251056cbb"
  download_verified_asset \
    "t5-small tokenizer config" \
    "https://huggingface.co/optimum/t5-small/resolve/main/tokenizer_config.json" \
    "${t5_dir}/tokenizer_config.json" \
    "4969f8d76ef05a16553bd2b07b3501673ae8d36972aea88a0f78ad31a3ff2de9"
  download_verified_asset \
    "t5-small config" \
    "https://huggingface.co/optimum/t5-small/resolve/main/config.json" \
    "${t5_dir}/config.json" \
    "d112428e703aa7ea0d6b17a77e9739fcc15b87653779d9b7942d5ecbc61c00ed"
  write_summarizer_manifest "$t5_dir"

  if [[ ! -f "$runtime_lib" ]]; then
    download_verified_asset "ONNX Runtime" "$runtime_url" "$runtime_archive" "$runtime_sha"
    info "Extracting ONNX Runtime"
    tar -xzf "$runtime_archive" -C "$runtime_dir"
  fi
  [[ -f "$runtime_lib" ]] || die "ONNX Runtime library not found after extraction: ${runtime_lib}"
}

check_openclaw_version() {
  local raw detected
  raw="$(openclaw --version 2>/dev/null || openclaw version 2>/dev/null || true)"
  detected="$(printf '%s\n' "$raw" | grep -Eo '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [[ -z "$detected" ]]; then
    warn "Could not parse OpenClaw version from: ${raw:-<empty>}"
    warn "Expected OpenClaw >= ${OPENCLAW_MIN_VERSION}."
    return 0
  fi
  if ! version_ge "$detected" "$OPENCLAW_MIN_VERSION"; then
    die "OpenClaw ${detected} detected. Minimum supported version is ${OPENCLAW_MIN_VERSION}. Upgrade OpenClaw and rerun this installer."
  fi
}

append_path_once() {
  local line='export PATH="$HOME/.local/bin:$PATH"'
  local shell_name rc_candidates=()
  shell_name="$(basename "${SHELL:-}")"
  if [[ ":$PATH:" == *":$HOME/.local/bin:"* ]]; then
    return 0
  fi
  case "$shell_name" in
    zsh) rc_candidates=("$HOME/.zshrc") ;;
    bash) rc_candidates=("$HOME/.bashrc") ;;
    *) rc_candidates=("$HOME/.bashrc" "$HOME/.zshrc") ;;
  esac
  for rc in "${rc_candidates[@]}"; do
    [[ -f "$rc" ]] || continue
    if ! grep -Eq '(^|[^[:alnum:]_])(\$HOME|~)/\.local/bin([^[:alnum:]_]|$)' "$rc"; then
      printf '\n%s\n' "$line" >> "$rc"
      info "Added ~/.local/bin to PATH in $(basename "$rc")"
      info "Run: source ~/${rc##*/} (or restart your terminal) to pick it up in new shells."
    fi
  done
}

install_daemon_macos_brew() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] brew tap ${REPO_OWNER_LOWER}/${TAP_REPO}"
    info "[dry-run] brew install/upgrade libravdbd"
    info "[dry-run] brew services start/restart libravdbd"
    return 0
  fi
  if ! command -v brew >/dev/null 2>&1; then
    warn "Homebrew not found on macOS."
    return 1
  fi
  info "Installing daemon with Homebrew tap ${REPO_OWNER_LOWER}/${TAP_REPO}"
  warn "If the tap requires credentials, Homebrew may prompt interactively."
  brew tap "${REPO_OWNER_LOWER}/${TAP_REPO}" || return 1
  if brew list libravdbd >/dev/null 2>&1; then
    info "Existing Homebrew daemon install found; upgrading libravdbd."
    brew upgrade libravdbd || return 1
    brew services restart libravdbd || return 1
  else
    brew install libravdbd || return 1
    brew services start libravdbd || return 1
  fi
  return 0
}

install_openclaw_plugin_package() {
  local output
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] openclaw plugins install ${PLUGIN_PACKAGE}"
    return 0
  fi
  if output="$(openclaw plugins install "$PLUGIN_PACKAGE" 2>&1)"; then
    printf '%s\n' "$output"
    return 0
  fi
  if printf '%s\n' "$output" | grep -qi "plugin already exists"; then
    warn "Plugin package already installed; attempting update and continuing with existing package if already current."
    if openclaw plugins update "$PLUGIN_ID"; then
      return 0
    fi
    warn "OpenClaw plugin update did not complete; continuing because ${PLUGIN_ID} is already installed."
    return 0
  fi
  printf '%s\n' "$output" >&2
  die "Plugin install failed. Try: openclaw plugins install ${PLUGIN_PACKAGE}"
}

install_daemon_manual() {
  local os="$1"
  local arch="$2"
  local tag tag_norm asset url checksum_url expected_sha actual_sha bin_dir bin_path current current_norm

  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] resolve latest release tag from ${REPO_OWNER_LOWER}/${TAP_REPO}"
    info "[dry-run] download daemon asset for ${os}/${arch} into ~/.local/bin/libravdbd"
    info "[dry-run] verify checksum and mark daemon executable"
    provision_manual_assets "$os" "$arch"
    return 0
  fi

  asset="$(daemon_asset_name "$os" "$arch")" || die "No published daemon asset for ${os}/${arch}"
  if ! tag="$(latest_release_tag)"; then
    die "Unable to detect latest daemon release tag from ${REPO_OWNER_LOWER}/${TAP_REPO}. Check network access and rerun."
  fi
  [[ -n "$tag" ]] || die "Unable to detect latest daemon release tag from ${REPO_OWNER_LOWER}/${TAP_REPO}. Check network access and rerun."
  tag_norm="${tag#v}"
  url="${DAEMON_RELEASE_BASE}/${tag}/${asset}"

  bin_dir="$HOME/.local/bin"
  bin_path="${bin_dir}/libravdbd"
  mkdir -p "$bin_dir"

  if [[ -x "$bin_path" ]]; then
    current="$(daemon_version "$bin_path" | grep -Eo 'v?[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
    current_norm="${current#v}"
    if [[ -n "$current_norm" && "$current_norm" == "$tag_norm" ]]; then
      info "libravdbd ${tag} already installed at ${bin_path}; skipping manual daemon download."
      provision_manual_assets "$os" "$arch"
      return 0
    fi
  fi

  info "Downloading daemon asset: ${url}"
  DOWNLOADED_BIN_PATH="$bin_path"
  curl -fL --retry 3 --retry-delay 1 --connect-timeout 10 --max-time 120 --progress-bar -o "$bin_path" "$url"
  checksum_url="${url}.sha256"
  if ! expected_sha="$(curl -fsSL --retry 3 --retry-delay 1 --connect-timeout 10 --max-time 30 "$checksum_url" | awk '{print $1}')"; then
    die "Failed to fetch checksum from ${checksum_url}"
  fi
  [[ -n "$expected_sha" ]] || die "Failed to read checksum from ${checksum_url}"
  actual_sha="$(sha256_file "$bin_path")"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    rm -f "$bin_path"
    die "Checksum mismatch for downloaded daemon asset."
  fi
  info "Checksum verified for downloaded daemon binary."
  chmod +x "$bin_path"
  DOWNLOADED_BIN_PATH=""
  append_path_once
  export PATH="$bin_dir:$PATH"
  provision_manual_assets "$os" "$arch"
}

write_launchd_plist() {
  local dst="$HOME/Library/LaunchAgents/com.xdarkicex.libravdbd.plist"
  local daemon_bin="$HOME/.local/bin/libravdbd"
  local os arch models_dir runtime_lib
  local escaped_home escaped_daemon_bin escaped_runtime_lib escaped_models_dir

  os="$(detect_os)"
  arch="$(detect_arch)"
  models_dir="$(manual_models_dir)"
  runtime_lib="$(manual_runtime_lib_path "$os" "$arch")"

  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$HOME/.libravdbd/run"
  escaped_home="$(xml_escape "$HOME")"
  escaped_daemon_bin="$(xml_escape "$daemon_bin")"
  escaped_runtime_lib="$(xml_escape "$runtime_lib")"
  escaped_models_dir="$(xml_escape "$models_dir")"
  cat > "$dst" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.xdarkicex.libravdbd</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escaped_daemon_bin}</string>
      <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>LIBRAVDB_RPC_ENDPOINT</key>
      <string>unix:${escaped_home}/.libravdbd/run/libravdb.sock</string>
      <key>LIBRAVDB_DB_PATH</key>
      <string>${escaped_home}/.libravdbd/data_nomic-embed-text-v1_5.libravdb</string>
      <key>LIBRAVDB_ONNX_RUNTIME</key>
      <string>${escaped_runtime_lib}</string>
      <key>LIBRAVDB_EMBEDDING_BACKEND</key>
      <string>onnx-local</string>
      <key>LIBRAVDB_EMBEDDING_PROFILE</key>
      <string>nomic-embed-text-v1.5</string>
      <key>LIBRAVDB_EMBEDDING_MODEL</key>
      <string>${escaped_models_dir}/nomic-embed-text-v1.5/model.onnx</string>
      <key>LIBRAVDB_EMBEDDING_TOKENIZER</key>
      <string>${escaped_models_dir}/nomic-embed-text-v1.5/tokenizer.json</string>
      <key>LIBRAVDB_EMBEDDING_DIMENSIONS</key>
      <string>768</string>
      <key>LIBRAVDB_EMBEDDING_NORMALIZE</key>
      <string>true</string>
      <key>LIBRAVDB_FALLBACK_PROFILE</key>
      <string>bge-small-en-v1.5</string>
      <key>LIBRAVDB_SUMMARIZER_BACKEND</key>
      <string>onnx-local</string>
      <key>LIBRAVDB_SUMMARIZER_MODEL_PATH</key>
      <string>${escaped_models_dir}/t5-small</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${escaped_home}/.libravdbd</string>
    <key>StandardOutPath</key>
    <string>${escaped_home}/Library/Logs/libravdbd.log</string>
    <key>StandardErrorPath</key>
    <string>${escaped_home}/Library/Logs/libravdbd.log</string>
  </dict>
</plist>
EOF
  echo "$dst"
}

setup_launchd_manual() {
  local plist
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] generate and bootstrap launchd agent com.xdarkicex.libravdbd"
    return 0
  fi
  plist="$(write_launchd_plist)"
  if launchctl print "gui/$(id -u)/com.xdarkicex.libravdbd" >/dev/null 2>&1; then
    if ! launchctl bootout "gui/$(id -u)/com.xdarkicex.libravdbd" >/dev/null 2>&1; then
      if launchctl print "gui/$(id -u)/com.xdarkicex.libravdbd" >/dev/null 2>&1; then
        die "Failed to unload existing launchd agent com.xdarkicex.libravdbd"
      fi
    fi
  fi
  rm -f "$HOME/.libravdbd/run/libravdb.sock"
  if ! launchctl bootstrap "gui/$(id -u)" "$plist"; then
    warn "Failed to bootstrap LaunchAgent ${plist}."
    return 1
  fi
  if ! launchctl kickstart -k "gui/$(id -u)/com.xdarkicex.libravdbd"; then
    warn "Failed to kickstart LaunchAgent com.xdarkicex.libravdbd."
    return 1
  fi
}

setup_systemd_manual() {
  local service="$HOME/.config/systemd/user/libravdbd.service"
  local os arch models_dir runtime_lib
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] write ${service}"
    info "[dry-run] systemctl --user enable --now libravdbd.service"
    return 0
  fi
  os="$(detect_os)"
  arch="$(detect_arch)"
  models_dir="$(manual_models_dir)"
  runtime_lib="$(manual_runtime_lib_path "$os" "$arch")"
  mkdir -p "$HOME/.config/systemd/user" "$HOME/.libravdbd/run"
  cat > "$service" <<EOF
[Unit]
Description=LibraVDB daemon (user)
After=network.target

[Service]
ExecStart=${HOME}/.local/bin/libravdbd serve
Restart=on-failure
RestartSec=5
WorkingDirectory=${HOME}/.libravdbd
Environment=LIBRAVDB_RPC_ENDPOINT=unix:${HOME}/.libravdbd/run/libravdb.sock
Environment=LIBRAVDB_DB_PATH=${HOME}/.libravdbd/data_nomic-embed-text-v1_5.libravdb
Environment=LIBRAVDB_ONNX_RUNTIME=${runtime_lib}
Environment=LIBRAVDB_EMBEDDING_BACKEND=onnx-local
Environment=LIBRAVDB_EMBEDDING_PROFILE=nomic-embed-text-v1.5
Environment=LIBRAVDB_EMBEDDING_MODEL=${models_dir}/nomic-embed-text-v1.5/model.onnx
Environment=LIBRAVDB_EMBEDDING_TOKENIZER=${models_dir}/nomic-embed-text-v1.5/tokenizer.json
Environment=LIBRAVDB_EMBEDDING_DIMENSIONS=768
Environment=LIBRAVDB_EMBEDDING_NORMALIZE=true
Environment=LIBRAVDB_FALLBACK_PROFILE=bge-small-en-v1.5
Environment=LIBRAVDB_SUMMARIZER_BACKEND=onnx-local
Environment=LIBRAVDB_SUMMARIZER_MODEL_PATH=${models_dir}/t5-small

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now libravdbd.service
}

start_background_daemon() {
  if [[ -f "$HOME/.libravdbd/libravdbd.pid" ]]; then
    local pid
    pid="$(cat "$HOME/.libravdbd/libravdbd.pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      info "Manual daemon already running with pid ${pid}; skipping duplicate start."
      return 0
    fi
  fi

  if pgrep -f "libravdbd serve" >/dev/null 2>&1; then
    warn "Detected an existing manual libravdbd process; skipping duplicate start."
    return 0
  fi

  mkdir -p "$HOME/.libravdbd" "$HOME/.libravdbd/run"
  rm -f "$HOME/.libravdbd/run/libravdb.sock"
  local os arch models_dir runtime_lib
  os="$(detect_os)"
  arch="$(detect_arch)"
  models_dir="$(manual_models_dir)"
  runtime_lib="$(manual_runtime_lib_path "$os" "$arch")"
  LIBRAVDB_RPC_ENDPOINT="unix:${HOME}/.libravdbd/run/libravdb.sock" \
    LIBRAVDB_DB_PATH="${HOME}/.libravdbd/data_nomic-embed-text-v1_5.libravdb" \
    LIBRAVDB_ONNX_RUNTIME="$runtime_lib" \
    LIBRAVDB_EMBEDDING_BACKEND="onnx-local" \
    LIBRAVDB_EMBEDDING_PROFILE="nomic-embed-text-v1.5" \
    LIBRAVDB_EMBEDDING_MODEL="${models_dir}/nomic-embed-text-v1.5/model.onnx" \
    LIBRAVDB_EMBEDDING_TOKENIZER="${models_dir}/nomic-embed-text-v1.5/tokenizer.json" \
    LIBRAVDB_EMBEDDING_DIMENSIONS="768" \
    LIBRAVDB_EMBEDDING_NORMALIZE="true" \
    LIBRAVDB_FALLBACK_PROFILE="bge-small-en-v1.5" \
    LIBRAVDB_SUMMARIZER_BACKEND="onnx-local" \
    LIBRAVDB_SUMMARIZER_MODEL_PATH="${models_dir}/t5-small" \
    nohup "$HOME/.local/bin/libravdbd" serve > "$HOME/.libravdbd/libravdbd.log" 2>&1 &
  echo $! > "$HOME/.libravdbd/libravdbd.pid"
  warn "Started background daemon without systemd. The pid file is ${HOME}/.libravdbd/libravdbd.pid."
}

start_manual_daemon() {
  local platform="$1"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] start manual daemon for ${platform}"
    return 0
  fi
  if [[ "$platform" == "darwin" ]]; then
    if setup_launchd_manual; then
      return 0
    fi
    warn "LaunchAgent startup failed; falling back to a background daemon for this login session."
    start_background_daemon
    return 0
  fi

  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    setup_systemd_manual
    return 0
  fi

  start_background_daemon
}

xml_escape() {
  local input="$1"
  input="${input//&/&amp;}"
  input="${input//</&lt;}"
  input="${input//>/&gt;}"
  input="${input//\"/&quot;}"
  input="${input//\'/&apos;}"
  printf '%s' "$input"
}

verify_manual_daemon_ready() {
  local socket_path="$HOME/.libravdbd/run/libravdb.sock"
  local i
  for i in {1..120}; do
    if [[ -S "$socket_path" ]]; then
      info "Manual daemon socket detected at ${socket_path}."
      info "Daemon socket is present; OpenClaw RPC health is verified in the later status retry check."
      return 0
    fi
    sleep 1
  done
  warn "Manual daemon socket was not detected at ${socket_path} after waiting."
  warn "If startup failed, inspect logs under ~/.libravdbd or ~/Library/Logs/libravdbd.log."
  return 1
}

verify_openclaw_memory_status_with_retry() {
  local attempts=6
  local i
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] verify OpenClaw memory status (with retry)"
    return 0
  fi
  for ((i=1; i<=attempts; i++)); do
    if openclaw memory status >/dev/null 2>&1; then
      info "OpenClaw memory status passed on attempt ${i}/${attempts}."
      return 0
    fi
    sleep 1
  done
  return 1
}

configure_openclaw_json() {
  local config_dir="$HOME/.openclaw"
  local config_file="$config_dir/openclaw.json"
  local backup_file="${config_file}.bak.$(date +%Y%m%d_%H%M%S)_$$"
  local tmp

  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] backup and update ${config_file} with memory/context-engine slots and config"
    return 0
  fi

  mkdir -p "$config_dir"
  [[ -f "$config_file" ]] || echo '{}' > "$config_file"
  cp "$config_file" "$backup_file"
  LAST_CONFIG_BACKUP="$backup_file"
  info "Backed up config to $backup_file"

  tmp="$(mktemp)"
  TMP_FILES+=("$tmp")
  if ! jq --arg plugin "$PLUGIN_ID" '
    .plugins |= (. // {}) |
    .plugins.slots |= (. // {}) |
    .plugins.slots.memory = $plugin |
    .plugins.slots.contextEngine = $plugin |
    .plugins.entries |= (. // {}) |
    .plugins.entries[$plugin] = ((.plugins.entries[$plugin] // {}) + { enabled: true }) |
    .plugins.entries[$plugin].config = ((.plugins.entries[$plugin].config // {}) + {
      sidecarPath: (.plugins.entries[$plugin].config.sidecarPath // "auto")
    })
  ' "$config_file" > "$tmp"; then
    die "Failed to update ${config_file}. Original config left unchanged."
  fi
  if ! jq empty "$tmp" >/dev/null 2>&1; then
    die "Generated config JSON is invalid. Original config left unchanged."
  fi
  mv "$tmp" "$config_file"
}

print_header() {
  local os="$1"
  local arch="$2"
  local dry_run_notice=""
  if [[ "$DRY_RUN" -eq 1 ]]; then
    dry_run_notice=$'\n'"${YELLOW}[DRY RUN] No system changes will be made.${RESET}"
  fi
  cat <<EOF
${BOLD}LibraVDB Memory Auto-Installer${RESET}
Version: ${INSTALLER_VERSION}
Target: ${os}/${arch}
Requires: openclaw >= ${OPENCLAW_MIN_VERSION}, curl, jq, tar
${dry_run_notice}
This script will:
1) Install and start the local 'libravdbd' daemon.
2) Install the OpenClaw plugin package '${PLUGIN_PACKAGE}'.
3) Update '${HOME}/.openclaw/openclaw.json' so the memory and context-engine slots use '${PLUGIN_ID}'.
4) Run 'openclaw memory status' to verify connectivity.

No task/memory/spec databases in this repository are modified by this installer.
EOF
}

cleanup_on_exit() {
  local code=$?
  local tmp
  if [[ ${#TMP_FILES[@]} -gt 0 ]]; then
    for tmp in "${TMP_FILES[@]}"; do
      [[ -f "$tmp" ]] && rm -f "$tmp"
    done
  fi
  if [[ $code -ne 0 && -n "$DOWNLOADED_BIN_PATH" && -f "$DOWNLOADED_BIN_PATH" ]]; then
    rm -f "$DOWNLOADED_BIN_PATH"
  fi
}

print_summary() {
  local daemon_version="unknown"
  local daemon_bin
  local title="Installation complete."
  if [[ "$DRY_RUN" -eq 1 ]]; then
    title="Dry run complete. No changes were made."
  fi
  daemon_bin="$(command -v libravdbd || true)"
  if [[ -n "$daemon_bin" ]]; then
    daemon_version="$(daemon_version "$daemon_bin")"
  fi
  cat <<EOF

${GREEN}${BOLD}${title}${RESET}
Daemon: ${daemon_bin:-not-found} (${daemon_version})
Plugin package: ${PLUGIN_PACKAGE}
Config file: ${HOME}/.openclaw/openclaw.json
Config backup: ${LAST_CONFIG_BACKUP:-not-created}
Next check: openclaw memory status
EOF
}

uninstall_openclaw_config() {
  local config_file="$HOME/.openclaw/openclaw.json"
  local backup_file tmp
  if [[ ! -f "$config_file" ]]; then
    info "No OpenClaw config found at ${config_file}; skipping config cleanup."
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    warn "jq not found; skipping OpenClaw config cleanup."
    warn "Plugin slot/config entries for ${PLUGIN_ID} may still be present in ${config_file}."
    return 0
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] remove ${PLUGIN_ID} from OpenClaw memory/context-engine slots and config in ${config_file}"
    return 0
  fi
  backup_file="${config_file}.bak.$(date +%Y%m%d_%H%M%S)_uninstall_$$"
  cp "$config_file" "$backup_file"
  LAST_CONFIG_BACKUP="$backup_file"
  tmp="$(mktemp)"
  TMP_FILES+=("$tmp")
  if ! jq --arg plugin "$PLUGIN_ID" '
    .plugins |= (. // {}) |
    .plugins.slots |= (. // {}) |
    .plugins.entries |= (. // {}) |
    if .plugins.slots.memory == $plugin then del(.plugins.slots.memory) else . end |
    if .plugins.slots.contextEngine == $plugin then del(.plugins.slots.contextEngine) else . end |
    del(.plugins.entries[$plugin])
  ' "$config_file" > "$tmp"; then
    die "Failed to update ${config_file} during uninstall."
  fi
  if ! jq empty "$tmp" >/dev/null 2>&1; then
    die "Generated uninstall config JSON is invalid. Original config left unchanged."
  fi
  mv "$tmp" "$config_file"
  info "Updated OpenClaw config and backed up original to ${backup_file}."
}

uninstall_plugin_package() {
  if ! command -v openclaw >/dev/null 2>&1; then
    warn "openclaw CLI not found; skipping plugin uninstall command."
    return 0
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] openclaw plugins uninstall ${PLUGIN_PACKAGE}"
    return 0
  fi
  if openclaw plugins uninstall "$PLUGIN_PACKAGE" >/dev/null 2>&1; then
    info "Uninstalled plugin package ${PLUGIN_PACKAGE}."
  else
    warn "Plugin uninstall command did not complete cleanly. You may need to remove it with the OpenClaw CLI."
  fi
}

stop_daemon_services() {
  local os="$1"
  local label="gui/$(id -u)/com.xdarkicex.libravdbd"
  local launch_agent="$HOME/Library/LaunchAgents/com.xdarkicex.libravdbd.plist"
  local systemd_service="$HOME/.config/systemd/user/libravdbd.service"
  local pid

  if [[ "$os" == "darwin" ]]; then
    if command -v brew >/dev/null 2>&1 && brew list libravdbd >/dev/null 2>&1; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] brew services stop libravdbd"
      else
        brew services stop libravdbd || warn "Failed to stop Homebrew service libravdbd."
      fi
    fi
    if launchctl print "$label" >/dev/null 2>&1; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] launchctl bootout ${label}"
      else
        launchctl bootout "$label" || warn "Failed to bootout launchd agent ${label}."
      fi
    fi
    if [[ -f "$launch_agent" ]]; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] rm -f ${launch_agent}"
      else
        rm -f "$launch_agent"
      fi
    fi
    return 0
  fi

  if command -v systemctl >/dev/null 2>&1 && [[ -f "$systemd_service" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] systemctl --user disable --now libravdbd.service"
      info "[dry-run] rm -f ${systemd_service}"
    else
      systemctl --user disable --now libravdbd.service || warn "Failed to disable user systemd service."
      rm -f "$systemd_service"
    fi
  fi

  if [[ -f "$HOME/.libravdbd/libravdbd.pid" ]]; then
    pid="$(cat "$HOME/.libravdbd/libravdbd.pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] kill ${pid}"
      else
        kill "$pid" || warn "Failed to stop pid ${pid} from manual daemon start."
      fi
    fi
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] rm -f $HOME/.libravdbd/libravdbd.pid"
    else
      rm -f "$HOME/.libravdbd/libravdbd.pid"
    fi
  fi
}

remove_manual_daemon_binary() {
  local bin_path="$HOME/.local/bin/libravdbd"
  if [[ ! -f "$bin_path" ]]; then
    return 0
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] rm -f ${bin_path}"
    return 0
  fi
  rm -f "$bin_path"
  info "Removed manual daemon binary at ${bin_path}."
}

run_uninstall_mode() {
  local os
  os="$(detect_os)"

  echo -e "${BOLD}LibraVDB Memory Uninstall (Safe Mode)${RESET}"
  echo "This will stop/remove user-level daemon wiring and remove plugin assignments."
  echo "Data under ~/.libravdbd is not deleted."
  echo

  if ! confirm "Proceed with uninstall actions?"; then
    echo "Uninstall cancelled."
    exit 0
  fi

  stop_daemon_services "$os"
  uninstall_openclaw_config
  uninstall_plugin_package
  remove_manual_daemon_binary

  echo
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo -e "${GREEN}${BOLD}Dry run uninstall complete.${RESET}"
  else
    echo -e "${GREEN}${BOLD}Uninstall actions complete.${RESET}"
  fi
  if [[ -n "$LAST_CONFIG_BACKUP" ]]; then
    echo "OpenClaw config backup: ${LAST_CONFIG_BACKUP}"
  fi
}

main() {
  local os arch node_major

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --yes) ASSUME_YES=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --debug) DEBUG_MODE=1 ;;
      --uninstall) UNINSTALL_MODE=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown argument: $1" ;;
    esac
    shift
  done

  if [[ "$DEBUG_MODE" -eq 1 ]]; then
    set -x
  fi

  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    warn "Running as root is not recommended for this user-level installer."
    warn "Prefer running as a normal user to avoid permission conflicts."
  fi
  trap cleanup_on_exit EXIT INT TERM
  if [[ "$UNINSTALL_MODE" -eq 1 ]]; then
    run_uninstall_mode
    return 0
  fi
  check_command "openclaw" "OpenClaw CLI"
  check_command "curl" "curl"
  check_command "jq" "jq"
  check_command "tar" "tar"
  check_openclaw_version

  if command -v node >/dev/null 2>&1; then
    node_major="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [[ "$node_major" -lt 22 ]]; then
      warn "Node.js ${node_major} detected. Node.js 22+ is recommended."
    fi
  else
    warn "Node.js not found. Plugin runtime works best with Node.js 22+."
  fi

  os="$(detect_os)"
  arch="$(detect_arch)"

  print_header "$os" "$arch"
  echo

  if ! confirm "Proceed with installation on this machine?"; then
    echo "Installation cancelled."
    exit 0
  fi

  if [[ "$os" == "darwin" ]]; then
    if confirm "Use Homebrew for daemon install/management (recommended on macOS)?"; then
      if ! install_daemon_macos_brew; then
        warn "Homebrew daemon install failed; falling back to installer-managed daemon assets."
        install_daemon_manual "$os" "$arch"
        if confirm "Create/load LaunchAgent for manual daemon startup?"; then
          start_manual_daemon "$os"
          if [[ "$DRY_RUN" -eq 0 ]]; then
            verify_manual_daemon_ready || true
          fi
        fi
      fi
    else
      warn "Switching to manual daemon install on macOS."
      warn "Manual mode downloads the published daemon, ONNX Runtime, model assets, and LaunchAgent wiring."
      install_daemon_manual "$os" "$arch"
      if confirm "Create/load LaunchAgent for manual daemon startup?"; then
        start_manual_daemon "$os"
        if [[ "$DRY_RUN" -eq 0 ]]; then
          verify_manual_daemon_ready || true
        fi
      fi
    fi
  else
    install_daemon_manual "$os" "$arch"
    if confirm "Configure and start a user-level daemon service now?"; then
      start_manual_daemon "$os"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        verify_manual_daemon_ready || true
      fi
    fi
  fi

  if confirm "Install OpenClaw plugin package (${PLUGIN_PACKAGE}) now?"; then
    install_openclaw_plugin_package
  else
    warn "Skipping plugin install. Re-run later with: openclaw plugins install ${PLUGIN_PACKAGE}"
    exit 0
  fi

  if confirm "Update ~/.openclaw/openclaw.json memory/context-engine slots and config now?"; then
    configure_openclaw_json
  else
    warn "Skipped OpenClaw config update. Rerun this installer to apply the plugin slot/config."
  fi

  info "Verifying installation with: openclaw memory status"
  if verify_openclaw_memory_status_with_retry; then
    if [[ "$DRY_RUN" -eq 0 ]]; then
      openclaw memory status
    fi
    print_summary
  else
    warn "Verification reported an error."
    warn "Check daemon status and sidecar endpoint in ~/.openclaw/openclaw.json, then rerun: openclaw memory status"
    exit 1
  fi
}

main "$@"
