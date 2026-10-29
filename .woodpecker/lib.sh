# Step setup shared by the .woodpecker pipelines. Source it from a step's
# commands (POSIX sh: Woodpecker runs each step with `/bin/sh -e`).
#
# Every step has the host cache directory mounted at /cache. It holds the
# toolchains (pinned, sha256-verified, installed once), the language caches and
# one persistent clone of the repository at a fixed path, so that warm runs
# reuse build state and outputs do not depend on where the host checkout lives.

# .woodpecker/run mounts the host cache directory at /cache (woodpecker-cli
# exec --volumes); without it every run would start cold and lose its outputs.
grep -q ' /cache ' /proc/self/mountinfo || {
  echo "lib.sh: /cache is not mounted; start pipelines with .woodpecker/run" >&2
  return 1
}

export CACHE=/cache
export SRC=$CACHE/src

# the build settings .woodpecker/run passes (ZKNET_DIST_PLATFORMS, ZKNET_UPDATER_*)
if [ -f "$CI_WORKSPACE/.woodpecker/.run.env" ]; then
  set -a
  . "$CI_WORKSPACE/.woodpecker/.run.env"
  set +a
fi

export GOMODCACHE=$CACHE/go/mod GOCACHE=$CACHE/go/build GOTOOLCHAIN=local
export RUSTUP_HOME=$CACHE/rustup CARGO_HOME=$CACHE/cargo
# incremental state pays off only in local edit loops, and it grows the target directory
export CARGO_INCREMENTAL=0
export COREPACK_HOME=$CACHE/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export ZIG_GLOBAL_CACHE_DIR=$CACHE/zig
# Tauri's bundler keeps its downloaded tools (linuxdeploy, AppImage runtime) here
export XDG_CACHE_HOME=$CACHE/xdg
export NX_DAEMON=false NX_NO_CLOUD=true NX_TUI=false
# Woodpecker sets CI=woodpecker; the Tauri CLI (2.12) accepts only a boolean
export CI=true

# --- toolchains -------------------------------------------------------------

NODE_VERSION=24.22.0
NODE_SHA256=cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008
GO_VERSION=1.27.3
GO_SHA256=65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40
ZIG_VERSION=0.17.0
ZIG_SHA256=1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026
UPX_VERSION=5.2.1
UPX_SHA256=402162aad30af47e60dbd767fb2e64ca394ace9727ba1f40283641f1d1b91657
FOUNDRY_VERSION=1.8.5
FOUNDRY_SHA256=6c66ffcc55fa4249197721baa3098bc208014ea1d8aa04b2ed50ac6bccffb226
RUSTUP_VERSION=1.29.1
RUSTUP_SHA256=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71

# fetch URL SHA256 DIR [STRIP]: download a tarball, verify it and unpack it
# into DIR, once, dropping STRIP leading path components (default 1).
# Concurrent steps may race to the same DIR; the loser discards its copy.
fetch() {
  [ -d "$3" ] && return 0
  mkdir -p "$CACHE/tools"
  _tmp=$(mktemp -d "$CACHE/tools/.fetch.XXXXXX")
  curl -fsSL "$1" -o "$_tmp/archive"
  echo "$2  $_tmp/archive" | sha256sum -c --quiet -
  mkdir "$_tmp/x"
  tar -xf "$_tmp/archive" -C "$_tmp/x" --strip-components="${4:-1}"
  mv -T "$_tmp/x" "$3" 2>/dev/null || true
  rm -rf "$_tmp"
}

# tools NAME...: put pinned toolchains on PATH (linux-amd64 hosts only).
tools() {
  [ "$(uname -m)" = x86_64 ] || { echo "lib.sh: tools are pinned for x86_64 only" >&2; return 1; }
  for _t in "$@"; do
    case $_t in
      node)
        _d=$CACHE/tools/node-$NODE_VERSION
        fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$NODE_SHA256" "$_d"
        PATH=$_d/bin:$PATH
        # pnpm comes from the root package.json packageManager field
        [ -x "$_d/bin/pnpm" ] || corepack enable pnpm
        ;;
      go)
        _d=$CACHE/tools/go-$GO_VERSION
        fetch "https://go.dev/dl/go$GO_VERSION.linux-amd64.tar.gz" "$GO_SHA256" "$_d"
        PATH=$_d/bin:$PATH
        ;;
      zig)
        _d=$CACHE/tools/zig-$ZIG_VERSION
        fetch "https://ziglang.org/download/$ZIG_VERSION/zig-x86_64-linux-$ZIG_VERSION.tar.xz" "$ZIG_SHA256" "$_d"
        PATH=$_d:$PATH
        ;;
      upx)
        _d=$CACHE/tools/upx-$UPX_VERSION
        fetch "https://github.com/upx/upx/releases/download/v$UPX_VERSION/upx-$UPX_VERSION-amd64_linux.tar.xz" "$UPX_SHA256" "$_d"
        PATH=$_d:$PATH
        ;;
      foundry)
        _d=$CACHE/tools/foundry-$FOUNDRY_VERSION
        fetch "https://github.com/foundry-rs/foundry/releases/download/v$FOUNDRY_VERSION/foundry_v${FOUNDRY_VERSION}_linux_amd64.tar.gz" "$FOUNDRY_SHA256" "$_d" 0
        PATH=$_d:$PATH
        ;;
      rust)
        # The toolchain itself is pinned by rust-toolchain.toml; rustup
        # installs it on first use.
        if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
          mkdir -p "$CACHE/tools"
          # rustup selects its mode from the file name, so keep it
          _tmp=$(mktemp -d "$CACHE/tools/.fetch.XXXXXX")
          curl -fsSL "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/x86_64-unknown-linux-gnu/rustup-init" -o "$_tmp/rustup-init"
          echo "$RUSTUP_SHA256  $_tmp/rustup-init" | sha256sum -c --quiet -
          chmod +x "$_tmp/rustup-init"
          "$_tmp/rustup-init" -y -q --no-modify-path --profile minimal --default-toolchain none
          rm -rf "$_tmp"
        fi
        PATH=$CARGO_HOME/bin:$PATH
        ;;
      *)
        echo "lib.sh: unknown tool $_t" >&2
        return 1
        ;;
    esac
  done
  export PATH
}

# codename: the step image's OS release (noble, jammy, ...). Build state that
# depends on the image's system libraries is kept apart per release.
codename() {
  (. /etc/os-release && echo "$VERSION_CODENAME")
}

# apt_install PACKAGE...: Debian/Ubuntu step images, with the package archive
# on the cache volume so a warm run only unpacks.
apt_install() {
  _a=$CACHE/apt/$(codename)
  mkdir -p "$_a/partial"
  apt-get -qq -o Dir::Cache::archives="$_a" update
  DEBIAN_FRONTEND=noninteractive apt-get -qq -o Dir::Cache::archives="$_a" \
    install -y --no-install-recommends "$@" >/dev/null
}

# own_target_dir: give this step's Cargo builds a target directory of its
# image's release. Cargo's fingerprints do not cover the system glibc, so a
# target directory shared across images reuses build scripts and proc macros
# linked against another glibc (seen: GLIBC_2.39 not found, E0463 for tauri).
# An explicit --target-dir on the command line still wins.
own_target_dir() {
  export CARGO_TARGET_DIR="$SRC/dist/target-$(codename)"
}

# --- source -----------------------------------------------------------------

# checkout: make $SRC the committed HEAD of the mounted workspace, as a fresh
# clone would be, but keep the cargo target directories so that warm runs are
# incremental. Uncommitted changes are not built. node_modules goes with the
# other ignored files: install-time scripts generate state outside it (e.g.
# apps/ext's `wxt prepare` writes apps/ext/.wxt), and pnpm only reruns them on
# a real install, which the store on the cache volume keeps fast.
checkout() {
  git config --global --add safe.directory '*'
  [ -d "$SRC/.git" ] || git init -q "$SRC"
  # tags come from the workspace only, never from an earlier run's repository
  git -C "$SRC" tag -l | xargs -r git -C "$SRC" tag -d >/dev/null
  git -C "$SRC" fetch -q --force --tags "$CI_WORKSPACE" HEAD
  git -C "$SRC" checkout -q --force --detach FETCH_HEAD
  git -C "$SRC" clean -q -ffdx -e '/dist/target*'
  # bundles are outputs of this run only, not build state
  rm -rf "$SRC"/dist/target*/*/bundle
  # a server's clone has an origin, and goreleaser's release (not snapshot) needs one
  git -C "$SRC" remote add origin "$CI_WORKSPACE" 2>/dev/null || git -C "$SRC" remote set-url origin "$CI_WORKSPACE"
  echo "checkout: $(git -C "$SRC" describe --tags --always --long) at $SRC"
}

# pnpm_install: the workspace's Node dependencies, from the lockfile.
pnpm_install() {
  cd "$SRC"
  pnpm install --frozen-lockfile --store-dir "$CACHE/pnpm-store" --reporter=append-only
}

# rung: the build type this pipeline event selects, as an Nx configuration
# name. A tag builds the release rung; everything else builds dev.
rung() {
  if [ "$CI_PIPELINE_EVENT" = tag ]; then echo release; else echo dev; fi
}

# --- releases: a tag is one component's, <id>@<semver> (release/components.json)

# only PROJECT: end the step unless this pipeline builds the Nx project, which
# a development build always does and a release only for its tag's component.
only() {
  [ "$(rung)" = release ] || return 0
  node "$SRC/release/release.mjs" wanted "$1" && return 0
  echo "only: $1 is not part of the release $CI_COMMIT_TAG; skipped"
  exit 0
}

# stamp: write a release's version into its component's manifests in $SRC
# (needs node and cargo). The checkout is shared by the steps that follow.
stamp() {
  [ "$(rung)" = release ] || return 0
  node "$SRC/release/release.mjs" stamp
}
