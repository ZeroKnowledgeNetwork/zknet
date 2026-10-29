#!/bin/sh
# Cross-build zknet_client_cli for the distribution platforms with
# cargo-zigbuild, into dist/zknet_client_cli/<platform>/. Needs cargo-zigbuild
# (with zig and a macOS SDK, as in ghcr.io/rust-cross/cargo-zigbuild) and upx;
# the Nx target `client-cli:dist` runs it.
#
# On macOS, the darwin build is native instead: cargo and the Xcode SDK, the
# two architectures joined with lipo.
#
# Usage: dist.sh dev|release. The binaries are the same for both; release
# also writes the sha256 checksums. ZKNET_DIST_PLATFORMS (default "linux
# windows darwin") selects the platforms by OS.
set -eu

rung=${1:?usage: dist.sh dev|release}
cd "$(dirname "$0")/../../.."
out=dist/zknet_client_cli
target_dir=dist/target-zig

platforms=" ${ZKNET_DIST_PLATFORMS:-linux windows darwin} "
want() { case $platforms in *" $1 "*) return 0 ;; esac; return 1; }

rm -rf "$out"
targets=
want linux && targets="$targets x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu"
want windows && targets="$targets x86_64-pc-windows-gnu"
want darwin && targets="$targets x86_64-apple-darwin aarch64-apple-darwin"
# shellcheck disable=SC2086 # a list of target triples
rustup target add $targets

# build PLATFORM TARGET: the `.2.31` suffix sets the glibc floor (Debian 11,
# Ubuntu 20.04); universal2-apple-darwin lipos the two macOS architectures.
build() {
  cargo zigbuild --locked --release --target-dir "$target_dir" -p zknet_client_cli --target "$2"
  triple=${2%.2.31}
  bin=zknet_client_cli
  [ "${triple#*windows}" = "$triple" ] || bin=$bin.exe
  mkdir -p "$out/$1"
  cp "$target_dir/$triple/release/$bin" "$out/$1/"
}
# build_darwin_native: both macOS architectures with cargo, joined with lipo
build_darwin_native() {
  for t in x86_64-apple-darwin aarch64-apple-darwin; do
    cargo build --locked --release --target-dir "$target_dir" -p zknet_client_cli --target $t
  done
  mkdir -p "$out/darwin-universal"
  lipo -create -output "$out/darwin-universal/zknet_client_cli" \
    "$target_dir"/x86_64-apple-darwin/release/zknet_client_cli \
    "$target_dir"/aarch64-apple-darwin/release/zknet_client_cli
}

if want linux; then
  build linux-amd64 x86_64-unknown-linux-gnu.2.31
  build linux-arm64 aarch64-unknown-linux-gnu.2.31
fi
want windows && build windows-amd64 x86_64-pc-windows-gnu
if want darwin; then
  if [ "$(uname -s)" = Darwin ]; then build_darwin_native; else build darwin-universal universal2-apple-darwin; fi
fi

# UPX 5.2.1 refuses macOS binaries, so darwin stays unpacked
packable=$(ls "$out"/linux-*/zknet_client_cli "$out"/windows-amd64/zknet_client_cli.exe 2>/dev/null || true)
# shellcheck disable=SC2086 # paths without spaces
[ -z "$packable" ] || upx -q --best --lzma $packable

if [ "$rung" = release ]; then
  if command -v sha256sum >/dev/null; then sha256=sha256sum; else sha256="shasum -a 256"; fi
  (cd "$out" && $sha256 */zknet_client_cli* > checksums.txt)
fi
