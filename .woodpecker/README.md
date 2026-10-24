# Woodpecker pipelines

Local CI and distribution builds on the Woodpecker docker backend, run with
`woodpecker-cli exec` (Woodpecker 3.19). No server is needed and nothing runs
docker-in-docker: each step's image is the toolchain.

| Pipeline    | Does                                                                                                                                                                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yaml`   | The checks of `.github/workflows/ci.yml`: `nx format:check` and `nx run-many -t lint test build typecheck`                                                                                                                                                                                         |
| `dist.yaml` | WalletShield for linux-amd64, linux-arm64, darwin-amd64, darwin-arm64 and windows-amd64 (the clients' download export, `served/`; the release rung's archive keeps a darwin-universal binary); the CLI for linux-amd64, linux-arm64, darwin-universal and windows-amd64; the Linux desktop bundles |
| `lib.sh`    | Step setup both pipelines source: pinned toolchains, caches, the checkout                                                                                                                                                                                                                          |
| `run`       | The entry point: `woodpecker-cli exec` with the host cache directory mounted                                                                                                                                                                                                                       |

## Run

One pipeline at a time (they share the checkout in the cache directory):

```sh
.woodpecker/run ci
.woodpecker/run dist
```

`run` is `woodpecker-cli exec --local --backend-engine docker --volumes
<cache>:/cache` plus any further `exec` flags you pass before or after the
pipeline name.

The pipelines build the **committed `HEAD`**, the way a Woodpecker server builds
a pushed commit: commit first, or use the Nx targets below to build the working
tree. The pipeline definitions themselves are read from the working tree.

`dist.yaml` writes its outputs to `dist/woodpecker/`, owned by you:

```
dist/woodpecker/
├── walletshield/           goreleaser dist: <id>_<os>_<arch>/walletshield[.exe], artifacts.json,
│                           served/walletshield-<platform> + checksums.txt (the clients' names)
├── zknet_client_cli/       <platform>/zknet_client_cli[.exe]
└── zkn-client/             *.deb, *.rpm, *.AppImage
```

A cold run (empty cache) takes about 7 minutes and a warm one about 2. The
cache volume holds about 12 GB after `dist.yaml` and 19 GB once `ci.yaml` has
added its own Cargo build.

## The cache directory

Every step gets one host directory at `/cache`: the toolchains, the Go, Cargo,
pnpm, zig and apt caches, and the checkout (`/cache/src`). The pipelines
declare no volume; `run` mounts it with `exec --volumes`, so no
`--repo-trusted-volumes` is needed, and `lib.sh` stops a step whose `/cache`
is not mounted.

```sh
# The host cache directory, first match wins:
#   1. ZKNET_WOODPECKER_CACHE in the environment
#   2. ZKNET_WOODPECKER_CACHE in .woodpecker/local.env  (git-ignored)
#   3. /var/tmp/zknet-woodpecker                         (the default, in run)

.woodpecker/run dist                                          # default, or local.env
ZKNET_WOODPECKER_CACHE=/data/zknet-woodpecker .woodpecker/run dist   # this run only

# this machine, from now on:
cp .woodpecker/local.env.example .woodpecker/local.env
$EDITOR .woodpecker/local.env      # ZKNET_WOODPECKER_CACHE=/data/zknet-woodpecker
```

The path must be absolute and must outlive the environment the pipelines are
started from (in a container, a bind-mounted host path). Elsewhere, set the
same mount without `run`:

| Where                 | How                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `woodpecker-cli exec` | `--volumes <dir>:/cache`, or `WOODPECKER_VOLUMES=<dir>:/cache` in its environment        |
| a Woodpecker agent    | `WOODPECKER_BACKEND_DOCKER_VOLUMES=<dir>:/cache` (docker backend: mounted in every step) |
| a GitHub Actions job  | `run: .woodpecker/run dist` with `env: ZKNET_WOODPECKER_CACHE: …`                        |

Moving an existing cache keeps it warm (build state refers only to `/cache/...`
paths inside the steps). Its contents are root-owned:

```sh
sudo mv /var/tmp/zknet-woodpecker /data/zknet-woodpecker    # same filesystem
sudo rsync -a /var/tmp/zknet-woodpecker/ /data/zknet-woodpecker/ \
  && sudo rm -rf /var/tmp/zknet-woodpecker                  # across filesystems
echo ZKNET_WOODPECKER_CACHE=/data/zknet-woodpecker > .woodpecker/local.env
```

To reclaim the space instead:

```sh
docker run --rm -v /var/tmp:/v alpine rm -rf /v/zknet-woodpecker
```

## The Nx targets

Every build is an Nx target, so the pipeline, a human and a future native runner
call the same command. Each has a `dev` (default) and a `release` configuration:

| Target                        | `dev`                                                                                       | `release`                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `walletshield:dist`           | `goreleaser build --snapshot`, then `served.sh`: `served/` with checksums                   | `goreleaser release --skip=publish`: adds archives, checksums |
| `zknet_client_cli:dist`       | `scripts/dist.sh dev`                                                                       | `scripts/dist.sh release`: adds checksums                     |
| `@zknet/client:desktop-build` | `tauri build --debug` with the dev-local overlay, no updater artifacts, debug info stripped | `tauri build`: needs `TAURI_SIGNING_PRIVATE_KEY`              |

```sh
pnpm nx run @zknet/client:desktop-build             # dev, on this host
pnpm nx run @zknet/client:desktop-build:release     # macOS/Windows native runners, later
```

`walletshield:dist` and `zknet_client_cli:dist` need their cross toolchains
(goreleaser-cross, cargo-zigbuild, zig, upx), so build them through
`dist.yaml`, whose steps run exactly these targets inside the toolchain images.

The `dev` desktop bundle is a debug build (devtools, debug assertions) that
targets the local network: it merges `tauri.dev-local.conf.json` (network URL
`http://127.0.0.1:8765`, thin-mode WalletShield, the `dev-local` capability)
and `tauri.dev.conf.json` (no updater artifacts, so no signing key, and no in-app
update check: `plugins.zknet.updater` is `false`). Its
DWARF debug info is stripped (`CARGO_PROFILE_DEV_STRIP=debuginfo`): with it,
the binary is 411 MB and the rpm bundler takes over 20 minutes.

## What differs between the rungs

`dist.yaml` is one definition. A `tag` event selects the `release`
configuration of each Nx target (`rung` in `lib.sh`) and enables the
release-only steps `sign` and `publish`, which are stubs for now. Any other
event builds `dev`. Until a signing key is configured, the `desktop` step stops
a tag run before building. Try the release rung on a throwaway clone with a
test tag:

```sh
.woodpecker/run dist --pipeline-event tag --commit-ref refs/tags/v0.0.0-test
```

## Platform notes

- **glibc floor 2.31** for the Linux WalletShield and CLI binaries: zig
  (`-target x86_64-linux-gnu.2.31`) and cargo-zigbuild (`.2.31` target
  suffix): Debian 11 and Ubuntu 20.04 or later. Verified by running the
  packed linux-amd64 binaries on Debian 11 and Ubuntu 22.04.
- **UPX** packs the Linux and Windows binaries. UPX 5.2.1 refuses macOS.
- **SQIsign** is linked only into linux-amd64 WalletShield; the hpqc build
  for other platforms returns `ErrUnsupported`.
- The **desktop** Linux bundles build on **Ubuntu 22.04**, the oldest
  supported LTS, because they need the glibc and WebKitGTK they were built
  against: build on old systems to run on newer ones. The binary needs at most
  GLIBC_2.34 and the AppImage payload GLIBC_2.35. macOS and Windows bundles
  need native hosts and are not built here.
- **Cargo target directories never cross step images**: `own_target_dir` in
  `lib.sh` gives a step `dist/target-<release>` (e.g. `target-jammy`), because
  Cargo's fingerprints do not cover the system glibc.

## Differences from `ci.yml`

- **Foundry 1.8.5** is installed: `@zknet/anon-rpc-specifier:test` runs
  `forge` and `anvil`, which `ci.yml` does not install.
- The format check's base is the previous pipeline's commit
  (`CI_PREV_COMMIT_SHA`), else `HEAD~1`; `ci.yml` asks `nrwl/nx-set-shas` for
  the last green commit on `main`.
- No `nx fix-ci` (Nx Cloud self-healing); the workspace has no Nx Cloud.
- The Cargo target directory persists between runs in the cache directory;
  Cargo runs with `CARGO_INCREMENTAL=0`. `node_modules` is reinstalled every
  run, hard-linked from the pnpm store in the cache directory, so install-time
  scripts such as `apps/ext`'s `wxt prepare` always run.
- Go is 1.27.3 from `go.dev`; `ci.yml` uses whatever Go the runner image has.
