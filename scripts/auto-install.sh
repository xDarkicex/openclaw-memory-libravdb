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
INSTALLER_VERSION="1.1.0"

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
  brew tap "${REPO_OWNER_LOWER}/${TAP_REPO}"
  if brew list libravdbd >/dev/null 2>&1; then
    info "Existing Homebrew daemon install found; upgrading libravdbd."
    brew upgrade libravdbd
    brew services restart libravdbd
  else
    brew install libravdbd
    brew services start libravdbd
  fi
  return 0
}

install_daemon_manual() {
  local os="$1"
  local arch="$2"
  local tag tag_norm asset url checksum_url expected_sha actual_sha bin_dir bin_path current current_norm

  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] resolve latest release tag from ${REPO_OWNER_LOWER}/${TAP_REPO}"
    info "[dry-run] download daemon asset for ${os}/${arch} into ~/.local/bin/libravdbd"
    info "[dry-run] verify checksum and mark daemon executable"
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
    current="$("$bin_path" --version 2>/dev/null | grep -Eo 'v?[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
    current_norm="${current#v}"
    if [[ -n "$current_norm" && "$current_norm" == "$tag_norm" ]]; then
      info "libravdbd ${tag} already installed at ${bin_path}; skipping manual daemon download."
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

  warn "Manual daemon install does not provision Homebrew-managed runtime/model assets."
  warn "If the daemon fails to start, prefer Homebrew on macOS or follow docs for manual provisioning."
}

write_launchd_plist() {
  local dst="$HOME/Library/LaunchAgents/com.xdarkicex.libravdbd.plist"
  local daemon_bin="$HOME/.local/bin/libravdbd"
  local runtime_lib="$HOME/.local/share/libravdb/onnxruntime/lib/libonnxruntime.dylib"
  local escaped_home escaped_daemon_bin escaped_runtime_lib
  local runtime_block=""

  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$HOME/.libravdbd/run"
  escaped_home="$(xml_escape "$HOME")"
  escaped_daemon_bin="$(xml_escape "$daemon_bin")"
  escaped_runtime_lib="$(xml_escape "$runtime_lib")"
  if [[ -f "$runtime_lib" ]]; then
    runtime_block=$(cat <<EOF
      <key>LIBRAVDB_ONNX_RUNTIME</key>
      <string>${escaped_runtime_lib}</string>
EOF
)
  else
    warn "ONNX runtime library not found at ${runtime_lib}; launchd env will omit LIBRAVDB_ONNX_RUNTIME."
  fi
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
${runtime_block}
      <key>LIBRAVDB_SUMMARIZER_BACKEND</key>
      <string>bundled</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
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
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl kickstart -k "gui/$(id -u)/com.xdarkicex.libravdbd"
}

setup_systemd_manual() {
  local service="$HOME/.config/systemd/user/libravdbd.service"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] write ${service}"
    info "[dry-run] systemctl --user enable --now libravdbd.service"
    return 0
  fi
  mkdir -p "$HOME/.config/systemd/user" "$HOME/.libravdbd/run"
  cat > "$service" <<'EOF'
[Unit]
Description=LibraVDB daemon (user)
After=network.target

[Service]
ExecStart=%h/.local/bin/libravdbd serve
Restart=on-failure
RestartSec=5
Environment=LIBRAVDB_RPC_ENDPOINT=unix:%h/.libravdbd/run/libravdb.sock
Environment=LIBRAVDB_DB_PATH=%h/.libravdbd/data_nomic-embed-text-v1_5.libravdb

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now libravdbd.service
}

start_manual_daemon() {
  local os="$1"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] start manual daemon for ${os}"
    return 0
  fi
  if [[ "$os" == "darwin" ]]; then
    setup_launchd_manual
    return 0
  fi

  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    setup_systemd_manual
    return 0
  fi

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
  nohup "$HOME/.local/bin/libravdbd" serve > "$HOME/.libravdbd/libravdbd.log" 2>&1 &
  echo $! > "$HOME/.libravdbd/libravdbd.pid"
  warn "Started manual background daemon (no system service)."
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
  for i in {1..20}; do
    if [[ -S "$socket_path" ]]; then
      info "Manual daemon socket detected at ${socket_path}."
      info "Daemon socket is present; OpenClaw RPC health is verified in the later status retry check."
      return 0
    fi
    sleep 0.5
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
    info "[dry-run] backup and update ${config_file} with plugin slots/config"
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
    .plugins.configs |= (. // {}) |
    .plugins.configs[$plugin] |= (. // {}) |
    .plugins.configs[$plugin].sidecarPath = (.plugins.configs[$plugin].sidecarPath // "auto")
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
Requires: openclaw >= ${OPENCLAW_MIN_VERSION}, curl, jq
${dry_run_notice}
This script will:
1) Install and start the local 'libravdbd' daemon.
2) Install the OpenClaw plugin package '${PLUGIN_PACKAGE}'.
3) Update '${HOME}/.openclaw/openclaw.json' so both plugin slots use '${PLUGIN_ID}'.
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
    daemon_version="$(libravdbd --version 2>/dev/null | head -1 || echo unknown)"
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
    warn "Plugin slots/config entries for ${PLUGIN_ID} may still be present in ${config_file}."
    return 0
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] remove ${PLUGIN_ID} from OpenClaw slots/config in ${config_file}"
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
    .plugins.configs |= (. // {}) |
    if .plugins.slots.memory == $plugin then del(.plugins.slots.memory) else . end |
    if .plugins.slots.contextEngine == $plugin then del(.plugins.slots.contextEngine) else . end |
    del(.plugins.configs[$plugin])
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
    warn "Plugin uninstall command did not complete cleanly. You may need to remove it manually."
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
      install_daemon_macos_brew || die "Homebrew daemon install failed. Try 'brew logs libravdbd' and rerun."
    else
      warn "Switching to manual daemon install on macOS."
      warn "Manual mode can require extra runtime/model provisioning and is best-effort only."
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
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] openclaw plugins install ${PLUGIN_PACKAGE}"
    else
      openclaw plugins install "$PLUGIN_PACKAGE" || die "Plugin install failed. Try: openclaw plugins install ${PLUGIN_PACKAGE}"
    fi
  else
    warn "Skipping plugin install. Re-run later with: openclaw plugins install ${PLUGIN_PACKAGE}"
    exit 0
  fi

  if confirm "Update ~/.openclaw/openclaw.json plugin slots/config now?"; then
    configure_openclaw_json
  else
    warn "Skipped openclaw.json update. You must set plugin slots manually."
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
