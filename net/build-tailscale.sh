#!/usr/bin/env bash
# Build Tailscale CLI binaries (tailscale + tailscaled) into src-tauri/bin/<target>/.
# Used by desktop sysmesh (TUN + MagicDNS). Pin matches hathnet's go.mod when possible.
#
# Usage:
#   ./build-tailscale.sh              # host platform
#   ./build-tailscale.sh darwin-arm64
#   ./build-tailscale.sh linux-amd64
#   ./build-tailscale.sh windows-amd64
#   ./build-tailscale.sh all
set -euo pipefail

cd "$(dirname "$0")"

ROOT="$(cd .. && pwd)"
BIN_ROOT="$ROOT/src-tauri/bin"
# Keep in sync with net/go.mod tailscale.com version when bumping.
TS_VER="${TS_VER:-v1.82.0}"

resolve_mod() {
  local mod
  mod="$(go env GOPATH)/pkg/mod/tailscale.com@${TS_VER}"
  if [[ ! -d "$mod" ]]; then
    go get "tailscale.com@${TS_VER}"
    mod="$(go env GOPATH)/pkg/mod/tailscale.com@${TS_VER}"
  fi
  # Go module cache may be read-only; build from a writable copy.
  local tmp
  tmp="$(mktemp -d)"
  cp -R "$mod" "$tmp/tailscale"
  chmod -R u+w "$tmp/tailscale"
  echo "$tmp/tailscale"
}

build_one() {
  local goos="$1" goarch="$2" out_dir="$3" ext="${4:-}"
  echo "→ tailscale ${goos}/${goarch} → ${out_dir}"
  mkdir -p "$out_dir"
  local src
  src="$(resolve_mod)"
  (
    cd "$src"
    GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
      go build -o "${out_dir}/tailscale${ext}" ./cmd/tailscale
    GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
      go build -o "${out_dir}/tailscaled${ext}" ./cmd/tailscaled
  )
  rm -rf "$(dirname "$src")"
  ls -la "$out_dir"
}

host_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os/$arch" in
    Darwin/arm64) echo darwin-arm64 ;;
    Darwin/x86_64) echo darwin-amd64 ;;
    Linux/x86_64) echo linux-amd64 ;;
    Linux/amd64) echo linux-amd64 ;;
    MINGW*/x86_64|MSYS*/x86_64|CYGWIN*/x86_64) echo windows-amd64 ;;
    *)
      echo "unsupported host for default target: $os/$arch" >&2
      exit 1
      ;;
  esac
}

build_target() {
  case "$1" in
    darwin-arm64) build_one darwin arm64 "$BIN_ROOT/darwin-arm64" ;;
    darwin-amd64) build_one darwin amd64 "$BIN_ROOT/darwin-amd64" ;;
    linux-amd64) build_one linux amd64 "$BIN_ROOT/linux-amd64" ;;
    windows-amd64) build_one windows amd64 "$BIN_ROOT/windows-amd64" ".exe" ;;
    *)
      echo "unknown target: $1" >&2
      exit 1
      ;;
  esac
}

target="${1:-$(host_target)}"
case "$target" in
  all)
    build_target darwin-arm64
    build_target darwin-amd64
    build_target linux-amd64
    build_target windows-amd64
    ;;
  *) build_target "$target" ;;
esac
