# Releases

A pushed component tag on a commit of `main` becomes a GitHub pre-release with every platform's build
(`.github/workflows/release.yml`; a tag on any other commit fails its first step); a manual run of that workflow builds the same
without publishing. The pipelines build the same locally
(`.woodpecker/README.md`).

| file                                    | does                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `release/components.json`               | per tag prefix: the Nx project, git-cliff's paths, the manifests to stamp, the runners that build it                    |
| `release/release.mjs`                   | derives everything else from a tag: parse, stamp, notes, the desktop's Tauri configuration, the updater's `latest.json` |
| `release/build.sh`, `release/assets.sh` | the native macOS/Windows builds, and the release asset names                                                            |
| `cliff.toml`                            | git-cliff 2.14's release-note format                                                                                    |

## Components and tags

A release is one component's tag: **`<id>@<semver>`**, e.g. `client@0.2.0-beta.1`.
The tag is the version's source of truth: the manifests commit `0.0.0` and
the build stamps the tag's version. A rebuild is a new version; a tag never
carries `+build` metadata. `release/components.json` is the one place a
component's tag prefix lives, so renaming one is a one-line change there.

| tag prefix         | Nx project         | built on                                                      | release assets                                                                                                       |
| ------------------ | ------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `client`           | `client`           | Linux (Woodpecker), macOS universal, Windows (native)         | `.deb`, `.rpm` (not for a prerelease), `.AppImage`, `.dmg`, NSIS `-setup.exe`; the updater bundles, unsigned         |
| `client-cli`       | `client-cli`       | Linux + Windows (Woodpecker, cross), macOS universal (native) | the `zknet` binary: `zknet_<version>_<platform>[.exe]` for linux-amd64, linux-arm64, windows-amd64, darwin-universal |
| `app-walletshield` | `app-walletshield` | Linux + Windows (Woodpecker, cross), macOS (native)           | goreleaser's archives: linux amd64/arm64, windows amd64, darwin universal                                            |

**Keep `libs/rs-core/**` in `client`'s and `client-cli`'s paths**, although
the directory is gone: it is `libs/client-core`'s name before the rename
(`f7db79e`), and git-cliff matches each commit's paths as they were then.
Without it, every earlier `rs-core` change drops out of the notes; a first
release, which takes the whole history, loses 13 lines for `client@0.2.0-beta.3`.
**`app-walletshield`'s paths are WalletShield's dependency closure, not
`packages/opt/**`**: its own code, `common` and the `rpc_proxy` plugin it
imports (`go list -deps ./apps/walletshield`), its e2e tests and
`.goreleaser.yaml`. The rest of the module is other binaries (`pki`,
`genconfig`) that would otherwise fill its notes. Two entries are old names,
kept for the same reason as `rs-core`: `main.go` (WalletShield before
`apps/walletshield/`) and `http_proxy` (`rpc_proxy` before `c9c154b`).

**A prerelease builds no `.rpm`.** tauri-bundler 2.10.3 and later (rpm-rs 0.30)
refuse a version with `-`, which every semver prerelease has, so `release.mjs
tauri-config` drops `rpm` from the bundle targets for one. A stable version
builds it as before.

(`components.json` is JSON and can't carry these comments.)

Every release also carries `checksums.txt` (sha256 of every asset). Both the
desktop and the CLI build in `zknet-client-core` (`libs/client-core`, Nx `client-core`), so its commits
appear in both their notes. The darwin builds run natively on macOS, with
Xcode's SDK, never with an SDK inside a Linux image.

## Release notes

A release's notes run from the previous tag of the same component:

```sh
# the notes a client@0.2.0-beta.1 release would get; needs git-cliff 2.14
node release/release.mjs notes client@0.2.0-beta.1
```
