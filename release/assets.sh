#!/usr/bin/env bash
# Collect a release's build outputs on this runner into OUT, under the names
# they carry as release assets: <name>_<version>_<platform>[.<ext>]. The tag is
# ZKNET_TAG (<id>@<semver>).
#
#   release/assets.sh OUT
set -euo pipefail
shopt -s nullglob
out=${1:?usage: assets.sh OUT}
cd "$(dirname "$0")/.."
rel() { node release/release.mjs "$@"; }
project=$(rel parse | node -pe 'JSON.parse(require("fs").readFileSync(0)).project')
version=$(rel version)
mkdir -p "$out"

# put SRC NAME: copy one output, which must exist
put() {
  [ -f "$1" ] || { echo "assets.sh: missing $1" >&2; exit 1; }
  cp "$1" "$out/$2"
  echo "assets.sh: $2"
}

wp=dist/woodpecker
case "$(uname -s)-$project" in
  Linux-@zknet/client)
    for f in "$wp"/zkn-client/*; do put "$f" "$(basename "$f")"; done
    ;;
  Linux-zknet_client_cli)
    for p in linux-amd64 linux-arm64; do put "$wp/zknet_client_cli/$p/zknet_client_cli" "zknet_client_cli_${version}_$p"; done
    put "$wp/zknet_client_cli/windows-amd64/zknet_client_cli.exe" "zknet_client_cli_${version}_windows-amd64.exe"
    ;;
  Linux-walletshield | Darwin-walletshield)
    d=$wp/walletshield
    [ "$(uname -s)" = Linux ] || d=dist/walletshield
    for f in "$d"/*.tar.xz "$d"/*.zip; do put "$f" "$(basename "$f")"; done
    ;;
  Darwin-@zknet/client)
    b=dist/target/universal-apple-darwin/release/bundle
    for f in "$b"/dmg/*.dmg; do put "$f" "$(basename "$f")"; done
    # the updater bundle is named after the app only: add version and arch
    for f in "$b"/macos/*.app.tar.gz "$b"/macos/*.app.tar.gz.sig; do
      n=$(basename "$f")
      put "$f" "${n%%.app.tar.gz*}_${version}_universal.app.tar.gz${n#*.app.tar.gz}"
    done
    ;;
  Darwin-zknet_client_cli)
    put dist/zknet_client_cli/darwin-universal/zknet_client_cli "zknet_client_cli_${version}_darwin-universal"
    ;;
  MINGW*-@zknet/client | MSYS*-@zknet/client)
    for f in dist/target/release/bundle/nsis/*-setup.exe dist/target/release/bundle/nsis/*-setup.exe.sig; do
      put "$f" "$(basename "$f")"
    done
    ;;
  *)
    echo "assets.sh: no outputs for $project on $(uname -s)" >&2
    exit 1
    ;;
esac
[ -n "$(ls -A "$out")" ] || { echo "assets.sh: no assets collected" >&2; exit 1; }
