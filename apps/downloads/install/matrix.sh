#!/bin/sh
# Run test.sh inside a matrix of Linux distributions, each with its own /bin/sh
# and downloader, using Docker (or Podman: CONTAINER=podman).
#
#   sh matrix.sh
#   ZKNET_TEST_BINARY=<path> sh matrix.sh   # serve a real zknet in every distro
#
# Each container installs only python3 (the fixture server) and the downloader
# under test, so it needs network access to its package mirror.

set -eu

here=$(cd "$(dirname "$0")" && pwd)
app=$(dirname "$here")
engine=${CONTAINER:-docker}
command -v "$engine" >/dev/null 2>&1 || { echo "$engine is not installed" >&2; exit 1; }

binary_mount=
binary_env=
if [ -n "${ZKNET_TEST_BINARY:-}" ]; then
	binary_mount="-v $(cd "$(dirname "$ZKNET_TEST_BINARY")" && pwd)/$(basename "$ZKNET_TEST_BINARY"):/zknet:ro"
	binary_env="-e ZKNET_TEST_BINARY=/zknet"
fi

# image | what it covers | setup
matrix='
alpine:3.22|BusyBox ash, BusyBox wget, musl|apk add -q python3
alpine:3.22|BusyBox ash, curl, musl|apk add -q python3 curl
debian:12-slim|dash, curl|apt-get -qq update && apt-get -qq install -y python3-minimal curl >/dev/null
ubuntu:24.04|dash, GNU wget|apt-get -qq update && apt-get -qq install -y python3-minimal wget >/dev/null
fedora:43|bash as sh, curl|dnf -q install -y python3 >/dev/null
'

log=$(mktemp "${TMPDIR:-/tmp}/zknet-matrix.XXXXXX")
trap 'rm -f "$log"' EXIT
failed=''
rows=$(printf '%s\n' "$matrix" | grep '|')
IFS='
'
for row in $rows; do
	image=${row%%|*} rest=${row#*|}
	covers=${rest%%|*} setup=${rest#*|}
	printf '=== %s (%s): ' "$image" "$covers"
	# shellcheck disable=SC2086 # binary_mount and binary_env are option pairs
	if (IFS=' '; "$engine" run --rm --network host -v "$app:/app:ro" $binary_mount $binary_env \
		"$image" sh -c "$setup && sh /app/install/test.sh") >"$log" 2>&1; then
		tail -n 1 "$log"
	else
		echo FAILED
		cat "$log"
		failed="$failed $image"
	fi
done
[ -z "$failed" ] || { echo "failed:$failed" >&2; exit 1; }
