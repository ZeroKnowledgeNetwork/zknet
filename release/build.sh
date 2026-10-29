#!/usr/bin/env bash
# Build a release's component natively on this runner: the macOS and Windows
# share of .github/workflows/release.yml (Linux, and the CLI's and
# WalletShield's Windows builds, come from .woodpecker/dist.yaml). Runs the
# Nx targets, as a local machine would. The tag is ZKNET_TAG (<id>@<semver>).
#
#   release/build.sh
#
# A desktop build signs its updater bundles when TAURI_SIGNING_PRIVATE_KEY is
# set; ZKNET_UPDATER_PUBKEY and ZKNET_UPDATER_ENDPOINT configure the updater.
set -euo pipefail
cd "$(dirname "$0")/.."
rel() { node release/release.mjs "$@"; }
project=$(rel parse | node -pe 'JSON.parse(require("fs").readFileSync(0)).project')

rel stamp
case "$(uname -s)-$project" in
  Darwin-@zknet/client)
    TAURI_CONFIG=$(rel tauri-config) pnpm exec nx run @zknet/client:desktop-build:release \
      --args="--target universal-apple-darwin"
    ;;
  MINGW*-@zknet/client | MSYS*-@zknet/client)
    TAURI_CONFIG=$(rel tauri-config) pnpm exec nx run @zknet/client:desktop-build:release
    ;;
  Darwin-zknet_client_cli | Darwin-walletshield)
    ZKNET_DIST_PLATFORMS=darwin pnpm exec nx run "$project:dist:release"
    ;;
  *)
    echo "build.sh: nothing to build for $project on $(uname -s)" >&2
    exit 1
    ;;
esac
