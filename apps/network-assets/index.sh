#!/usr/bin/env bash
# Write the published root of a directory of assembled networks:
#
#   <out>/networks.json   the index of every <out>/<network_id>/network.json, newest first
#   <out>/_headers        Cloudflare Pages headers: the index is always revalidated
#   <out>/404.html        a real 404 for missing files, not Pages' single-page fallback
#
#   index.sh [--out DIR]   (default: generated/ beside this script)
#
# The index is derived from the directory alone: a network is listed while its
# directory exists. Needs bash and coreutils.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
out=$here/generated
usage='usage: index.sh [--out DIR]'

while [ $# -gt 0 ]; do
  case $1 in
    --out) out=${2:?$usage}; shift 2 ;;
    -h | --help) echo "$usage"; exit 0 ;;
    *) echo "index: $usage" >&2; exit 1 ;;
  esac
done
mkdir -p "$out"

# each network.json is one line whose "created" sorts by time (RFC 3339 UTC)
created() { sed -n 's/.*"created": *"\([^"]*\)".*/\1/p' "$1"; }
entries=()
while IFS=$'\t' read -r _ file; do
  entries+=("$(cat "$file")")
done < <(
  for file in "$out"/*/network.json; do
    [ -f "$file" ] || continue
    printf '%s\t%s\n' "$(created "$file")" "$file"
  done | sort -r
)

index=$(mktemp "$out/.networks.json.XXXXXX")
trap 'rm -f "$index"' EXIT
{
  printf '{\n  "schema": 1,\n  "networks": ['
  for i in "${!entries[@]}"; do
    [ "$i" = 0 ] || printf ','
    printf '\n    %s' "${entries[$i]}"
  done
  [ ${#entries[@]} = 0 ] || printf '\n  '
  printf ']\n}\n'
} >"$index"
chmod 644 "$index"
mv "$index" "$out/networks.json"
cp "$here/site/_headers" "$here/site/404.html" "$out/"
echo "Indexed ${#entries[@]} network(s) in $out/networks.json"
