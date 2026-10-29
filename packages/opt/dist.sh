#!/bin/sh
# goreleaser for the Nx target `app-walletshield:dist`, with the version taken from
# WalletShield's own tags only (`git describe` would take any component's).
#
#   dist.sh dev       a snapshot build, version `git describe` of the WalletShield tags
#   dist.sh release   the archives and checksums of the release in ZKNET_TAG or
#                     CI_COMMIT_TAG (<id>@<semver>, release/components.json)
#
# goreleaser OSS needs a `v<semver>` tag at HEAD for a release: this creates
# one locally for the run, never pushed, and removes it on exit.
# ZKNET_DIST_PLATFORMS (default "linux windows darwin") selects the builds.
set -eu
cd "$(dirname "$0")"
rung=${1:?usage: dist.sh dev|release}
id=$(node ../../release/release.mjs id app-walletshield)

case $rung in
  dev)
    ZKNET_SNAPSHOT_VERSION=$(git describe --tags --match "$id@*" --always --dirty)
    export ZKNET_SNAPSHOT_VERSION=${ZKNET_SNAPSHOT_VERSION#"$id@"}
    goreleaser build --snapshot --clean
    ;;
  release)
    version=$(node ../../release/release.mjs version)
    tag=v$version
    if ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
      git tag "$tag"
      trap 'git tag -d "$tag" >/dev/null' EXIT INT TERM
    fi
    GORELEASER_CURRENT_TAG=$tag goreleaser release --clean --skip=publish
    ;;
  *)
    echo "usage: dist.sh dev|release" >&2
    exit 1
    ;;
esac
./served.sh
