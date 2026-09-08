#!/usr/bin/env bash
# Build libhathnet.a (+ .h) for the selected target into src-tauri/lib/.
# Usage:
#   ./build.sh              # darwin-arm64 (default)
#   ./build.sh darwin-arm64
#   ./build.sh darwin-amd64
#   ./build.sh ios-arm64
#   ./build.sh linux-amd64
#   ./build.sh windows-amd64
#   ./build.sh all
set -euo pipefail

cd "$(dirname "$0")"

ROOT="$(cd .. && pwd)"
LIB_ROOT="$ROOT/src-tauri/lib"

build_darwin_arm64() {
  echo "→ darwin-arm64"
  mkdir -p "$LIB_ROOT/darwin-arm64"
  CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 \
    go build -buildmode=c-archive -o "$LIB_ROOT/darwin-arm64/libhathnet.a" .
}

build_darwin_amd64() {
  echo "→ darwin-amd64"
  mkdir -p "$LIB_ROOT/darwin-amd64"
  CGO_ENABLED=1 GOOS=darwin GOARCH=amd64 \
    go build -buildmode=c-archive -o "$LIB_ROOT/darwin-amd64/libhathnet.a" .
}

build_ios_arm64() {
  echo "→ ios-arm64"
  mkdir -p "$LIB_ROOT/ios-arm64"
  local clang sdk
  clang="$(xcrun --sdk iphoneos --find clang)"
  sdk="$(xcrun --sdk iphoneos --show-sdk-path)"
  CGO_ENABLED=1 GOOS=ios GOARCH=arm64 \
    CC="$clang -isysroot $sdk -arch arm64 -miphoneos-version-min=13.0" \
    go build -buildmode=c-archive -o "$LIB_ROOT/ios-arm64/libhathnet.a" .
}

build_linux_amd64() {
  echo "→ linux-amd64"
  mkdir -p "$LIB_ROOT/linux-amd64"
  CGO_ENABLED=1 GOOS=linux GOARCH=amd64 \
    go build -buildmode=c-archive -o "$LIB_ROOT/linux-amd64/libhathnet.a" .
}

# Go c-archive on Windows is MinGW-only; pair with Rust target x86_64-pc-windows-gnu.
build_windows_amd64() {
  echo "→ windows-amd64"
  mkdir -p "$LIB_ROOT/windows-amd64"
  local cc="${CC:-}"
  if [[ -z "$cc" ]]; then
    if command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
      cc=x86_64-w64-mingw32-gcc
    elif command -v gcc >/dev/null 2>&1; then
      cc=gcc
    else
      echo "windows-amd64: need MinGW gcc (x86_64-w64-mingw32-gcc or gcc) on PATH" >&2
      exit 1
    fi
  fi
  CGO_ENABLED=1 GOOS=windows GOARCH=amd64 CC="$cc" \
    go build -buildmode=c-archive -o "$LIB_ROOT/windows-amd64/libhathnet.a" .
}

target="${1:-darwin-arm64}"

case "$target" in
  darwin-arm64) build_darwin_arm64 ;;
  darwin-amd64) build_darwin_amd64 ;;
  ios-arm64) build_ios_arm64 ;;
  linux-amd64) build_linux_amd64 ;;
  windows-amd64) build_windows_amd64 ;;
  all)
    build_darwin_arm64
    build_darwin_amd64
    build_ios_arm64
    build_linux_amd64
    build_windows_amd64
    ;;
  *)
    echo "unknown target: $target" >&2
    echo "expected: darwin-arm64 | darwin-amd64 | ios-arm64 | linux-amd64 | windows-amd64 | all" >&2
    exit 1
    ;;
esac

echo "done → $LIB_ROOT"
