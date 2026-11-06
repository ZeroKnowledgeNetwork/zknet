#!/bin/sh
# Install the ZKNet command-line client, zknet.
#
#   curl -fsSL https://get.zknet.io/install.sh | sh
#   curl -fsSL https://get.zknet.io/install.sh | sh -s -- --help
#
# It reads the CLI's current release from
# https://dist.zknet.io/updates/client-cli/<channel>/downloads.json, downloads
# the binary for this machine, checks its size and SHA-256 against that file,
# and puts it in ~/.local/bin. It needs no root and asks for no input; it does
# not edit shell profiles. Read it before you run it: it is meant to be short
# enough for that.
#
# Every line is inside a function, and nothing runs until the last line calls
# main, so a download cut off half way runs nothing at all.

set -eu

DEFAULT_BASE='https://dist.zknet.io/updates'
DEFAULT_CHANNEL='beta'
COMPONENT='client-cli'
BIN='zknet'
# The oldest glibc the Linux build runs on: the .2.31 of its build target in
# apps/client-cli/scripts/dist.sh. Only named in an error; whether the binary
# runs is decided by running it.
GLIBC_FLOOR='2.31'

usage() {
	cat <<'EOF'
Install the ZKNet command-line client, zknet.

Usage: install.sh [OPTIONS]
       curl -fsSL https://get.zknet.io/install.sh | sh -s -- [OPTIONS]

Options:
  --channel <name>   Release channel to install from [default: beta]
  --version <ver>    Install only if the channel's current release is <ver>;
                     refuse otherwise (for reproducible scripts)
  --dir <path>       Install directory [default: $XDG_BIN_HOME, or ~/.local/bin]
  --uninstall        Remove zknet from the install directory, keeping its data
  -h, --help         Print this help

Environment (a flag wins over its variable):
  ZKNET_CHANNEL          as --channel
  ZKNET_VERSION          as --version
  ZKNET_INSTALL_DIR      as --dir
  ZKNET_DOWNLOADS_BASE   where downloads.json is read from
                         [default: https://dist.zknet.io/updates]; a mirror
                         given here is trusted for the checksums as well

It never asks for input and never uses sudo. It needs curl or wget, and
sha256sum, shasum or openssl.
EOF
}

say() {
	printf 'zknet-install: %s\n' "$*"
}

die() {
	printf 'zknet-install: error: %s\n' "$*" >&2
	exit 1
}

has() {
	command -v "$1" >/dev/null 2>&1
}

# The asset this machine runs, as "<os> <arch>" in downloads.json's terms.
detect_platform() {
	os=$(uname -s)
	arch=$(uname -m)
	case $os in
	Linux) os=linux ;;
	Darwin) os=macos ;;
	MINGW* | MSYS* | CYGWIN* | Windows_NT)
		die "this installer is for Linux and macOS; on Windows, download zknet from https://get.zknet.io" ;;
	*) die "unsupported operating system: $os (zknet ships for Linux and macOS)" ;;
	esac
	case $arch in
	x86_64 | amd64) arch=x86_64 ;;
	aarch64 | arm64) arch=arm64 ;;
	*) die "unsupported architecture: $arch on $os (zknet ships for x86_64 and arm64)" ;;
	esac
	# A shell under Rosetta 2 reports x86_64 on Apple silicon; sysctl does not.
	if [ "$os" = macos ] && [ "$arch" = x86_64 ] &&
		(sysctl hw.optional.arm64 2>/dev/null || true) | grep -q ': 1'; then
		arch=arm64
	fi
	printf '%s %s\n' "$os" "$arch"
}

# This Linux system's C library, for an error message.
libc_of() {
	for loader in /lib/ld-musl-*; do
		[ -e "$loader" ] && { echo musl; return; }
	done
	getconf GNU_LIBC_VERSION 2>/dev/null || echo 'an unknown C library'
}

# Download $1 to $2 over HTTPS (plain HTTP only from this machine's loopback).
download() {
	case $1 in
	https://*) proto='=https' ;;
	http://127.0.0.1[:/]* | http://localhost[:/]* | 'http://[::1]'[:/]*) proto='=http,https' ;;
	*) die "refusing a URL that is not HTTPS: $1" ;;
	esac
	if has curl; then
		curl --proto "$proto" --proto-redir "$proto" --tlsv1.2 --fail --silent --show-error \
			--location --retry 3 --output "$2" "$1" </dev/null ||
			die "download failed: $1"
	elif has wget; then
		if wget --version 2>/dev/null | grep -q 'GNU Wget'; then
			if [ "$proto" = '=https' ]; then
				wget --quiet --tries=3 --https-only --secure-protocol=TLSv1_2 \
					--output-document="$2" "$1" </dev/null || die "download failed: $1"
			else
				wget --quiet --tries=3 --output-document="$2" "$1" </dev/null ||
					die "download failed: $1"
			fi
		else
			# BusyBox wget: no flag refuses a redirect from HTTPS to HTTP
			wget -q -O "$2" "$1" </dev/null || die "download failed: $1"
		fi
	else
		die "neither curl nor wget is installed; install one and run this again"
	fi
}

sha256_of() {
	if has sha256sum; then
		sha256sum "$1" | cut -d ' ' -f 1
	elif has shasum; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	elif has openssl; then
		openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
	else
		die "no SHA-256 tool found (sha256sum, shasum or openssl); install one and run this again"
	fi
}

# downloads.json, flattened: no newlines, tabs or carriage returns.
flat() {
	tr -d '\n\r\t' <"$1"
}

# The string or number value of key $2 in the JSON text $1, empty when absent
# or null. The keys read here occur once in the text they are read from.
json_value() {
	printf '%s' "$1" | sed -n \
		-e "s/.*\"$2\" *: *\"\\([^\"]*\\)\".*/\\1/p" \
		-e "s/.*\"$2\" *: *\\([0-9][0-9]*\\).*/\\1/p" | head -n 1
}

# The assets array of downloads.json, one asset object per line. Assets are
# flat objects, so the first } after each { closes it.
assets_of() {
	printf '%s' "$1" | sed 's/.*"assets" *: *\[//' | tr '}' '\n' | grep '"kind"' || true
}

# The binary asset for $2 $3 (os arch) in the flattened downloads.json $1: the
# exact arch first, then a universal build.
pick_asset() {
	assets=$(assets_of "$1")
	for want in "$3" universal; do
		printf '%s\n' "$assets" | while IFS= read -r a; do
			if [ "$(json_value "$a" kind)" = binary ] && [ "$(json_value "$a" os)" = "$2" ] &&
				[ "$(json_value "$a" arch)" = "$want" ]; then
				printf '%s\n' "$a"
				break
			fi
		done
	done | head -n 1
}

default_dir() {
	[ -n "${HOME:-}" ] || die "HOME is not set; pass --dir"
	printf '%s\n' "${XDG_BIN_HOME:-$HOME/.local/bin}"
}

uninstall() {
	if [ -e "$dir/$BIN" ]; then
		rm -f "$dir/$BIN"
		say "removed $dir/$BIN"
		say "its data (known networks, logs) is kept; delete that by hand if you want it gone"
	else
		say "nothing to remove: $dir/$BIN does not exist"
	fi
}

install_zknet() {
	case $channel in
	'' | *[!a-z0-9-]*) die "not a channel name: $channel" ;;
	esac
	case $version in
	*[!0-9A-Za-z.+-]*) die "not a version: $version" ;;
	esac

	platform=$(detect_platform)
	os=${platform% *} arch=${platform#* }

	tmp=$(mktemp -d "${TMPDIR:-/tmp}/zknet-install.XXXXXX")
	trap 'rm -rf "$tmp"' EXIT
	trap 'rm -rf "$tmp"; exit 130' INT TERM

	url="${base%/}/$COMPONENT/$channel/downloads.json"
	say "reading $url"
	download "$url" "$tmp/downloads.json"
	doc=$(flat "$tmp/downloads.json")
	top=$(printf '%s' "$doc" | sed 's/"assets" *:.*//')
	[ "$(json_value "$top" schema)" = 1 ] && [ "$(json_value "$top" id)" = "$COMPONENT" ] ||
		die "$url is not a schema 1 downloads.json for $COMPONENT"
	current=$(json_value "$top" version)
	[ -n "$current" ] || die "$url names no version"
	if [ -n "$version" ] && [ "$version" != "$current" ]; then
		die "the $channel channel's current release is $current, not $version"
	fi

	asset=$(pick_asset "$doc" "$os" "$arch")
	[ -n "$asset" ] || die "zknet $current has no build for $os $arch"
	name=$(json_value "$asset" name)
	asset_url=$(json_value "$asset" url)
	size=$(json_value "$asset" size)
	sha256=$(json_value "$asset" sha256 | tr 'A-F' 'a-f')
	[ -n "$asset_url" ] || die "the $os $arch asset names no url"
	case $sha256 in
	'' | *[!0-9a-f]*) die "the $os $arch asset has no SHA-256; refusing to install what cannot be checked" ;;
	esac
	[ ${#sha256} -eq 64 ] || die "the $os $arch asset's SHA-256 is malformed"

	say "downloading zknet $current ($name)"
	download "$asset_url" "$tmp/$BIN"
	if [ -n "$size" ]; then
		got=$(wc -c <"$tmp/$BIN" | tr -d ' ')
		[ "$got" = "$size" ] || die "size mismatch for $name: expected $size bytes, got $got"
	fi
	got=$(sha256_of "$tmp/$BIN")
	[ "$got" = "$sha256" ] || die "SHA-256 mismatch for $name: expected $sha256, got $got; nothing was installed"
	say "verified SHA-256 $sha256"

	chmod 755 "$tmp/$BIN"
	if ! "$tmp/$BIN" --version </dev/null >/dev/null 2>&1; then
		[ "$os" = linux ] || die "the downloaded zknet does not run on this machine; nothing was installed"
		die "the downloaded zknet does not run on this machine; nothing was installed." \
			"zknet for Linux needs glibc $GLIBC_FLOOR or newer (Debian 11, Ubuntu 20.04, RHEL 9 and later);" \
			"this system has $(libc_of)"
	fi

	mkdir -p "$dir" 2>/dev/null || die "cannot create $dir; pass --dir with a directory you own"
	[ -w "$dir" ] || die "$dir is not writable; pass --dir with a directory you own"
	# Copy next to the target, then rename over it: a running zknet is not
	# disturbed, and no half-written zknet is ever on PATH.
	cp "$tmp/$BIN" "$dir/.$BIN.new.$$"
	chmod 755 "$dir/.$BIN.new.$$"
	mv -f "$dir/.$BIN.new.$$" "$dir/$BIN"
	say "installed zknet $current to $dir/$BIN"

	case ":${PATH:-}:" in
	*":$dir:"*)
		printf '\nNext: run  zknet --help\n' ;;
	*)
		printf '\n%s is not on your PATH. Add it, then open a new shell:\n' "$dir"
		# shellcheck disable=SC2016 # the user's shell expands $PATH, not this one
		printf '  sh, bash, zsh:  add  export PATH="%s:$PATH"  to ~/.profile, ~/.bashrc or ~/.zshrc\n' "$dir"
		printf '  fish:           fish_add_path %s\n' "$dir"
		printf '\nOr run it now:  %s/zknet --help\n' "$dir" ;;
	esac
}

main() {
	channel=${ZKNET_CHANNEL:-$DEFAULT_CHANNEL}
	version=${ZKNET_VERSION:-}
	dir=${ZKNET_INSTALL_DIR:-}
	base=${ZKNET_DOWNLOADS_BASE:-$DEFAULT_BASE}
	action=install
	while [ $# -gt 0 ]; do
		case $1 in
		-h | --help) usage; return 0 ;;
		--uninstall) action=uninstall ;;
		--channel | --version | --dir)
			[ $# -ge 2 ] || die "$1 needs a value"
			case $1 in
			--channel) channel=$2 ;;
			--version) version=$2 ;;
			--dir) dir=$2 ;;
			esac
			shift ;;
		--channel=*) channel=${1#*=} ;;
		--version=*) version=${1#*=} ;;
		--dir=*) dir=${1#*=} ;;
		*) die "unknown option: $1 (try --help)" ;;
		esac
		shift
	done
	[ -n "$dir" ] || dir=$(default_dir)

	case $action in
	install) install_zknet ;;
	uninstall) uninstall ;;
	esac
}

main "$@"
