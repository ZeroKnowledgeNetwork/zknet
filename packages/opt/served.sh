#!/usr/bin/env bash
# Export a WalletShield goreleaser dist in the layout the clients download:
# served/walletshield-<platform> for every client platform, and
# served/checksums.txt, their sha256. Chained after goreleaser in both rungs of
# the Nx target `walletshield:dist`. ZKNET_DIST_PLATFORMS (default "linux
# windows darwin") limits it to the builds of those OSes.
#
#   served.sh [DIST]    DIST: the goreleaser dist (default: the workspace's dist/walletshield)
set -euo pipefail
shopt -s nullglob

# goreleaser build id (.goreleaser.yaml) = client platform name
# (Platform::from_os_arch in libs/rs-core/src/network.rs)
platforms=(
  linux-amd64=linux-x64
  linux-arm64=linux-arm64
  darwin-amd64=macos-x64
  darwin-arm64=macos-arm64
  windows-amd64=windows-x64
)

selected=" ${ZKNET_DIST_PLATFORMS:-linux windows darwin} "
dist=${1:-$(dirname "$0")/../../dist/walletshield}
served=$dist/served
rm -rf "$served"
mkdir "$served"
for platform in "${platforms[@]}"; do
  id=${platform%%=*}
  [[ $selected == *" ${id%%-*} "* ]] || continue
  # goreleaser builds into <id>_<os>_<arch>[_<variant>]/walletshield[.exe]
  binaries=("$dist/${id}"_*/walletshield*)
  if [ ${#binaries[@]} != 1 ]; then
    echo "served.sh: expected one WalletShield build for $id in $dist, found ${#binaries[@]}" >&2
    exit 1
  fi
  cp -p "${binaries[0]}" "$served/walletshield-${platform#*=}"
done
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
(cd "$served" && sha256 walletshield-* >checksums.txt)
echo "served.sh: $served"
