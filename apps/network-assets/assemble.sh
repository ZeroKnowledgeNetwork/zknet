#!/usr/bin/env bash
# Assemble one network's client assets in the layout the clients download, and
# list it in the index (index.sh):
#
#   <out>/<network_id>/{client.toml,services.json,walletshield-<platform>,checksums.txt,network.json}
#   <out>/{networks.json,_headers,404.html}
#
#   assemble.sh [--served DIR] [--out DIR] [--kind KIND] [--name NAME]
#               <network_id> <client.toml> [<services.json>]
#   assemble.sh [--out DIR] --remove <network_id>
#
#   --served   the WalletShield dist export, served/ of `walletshield:dist`
#              (default: dist/woodpecker/walletshield/served)
#   --out      the directory of networks (default: generated/ beside this script)
#   --kind     local, devnet, testnet or mainnet (default: local for dev-local,
#              else the id's prefix before its first '-')
#   --name     the name clients show (default: "<Kind> · <YYYY-MM-DD>", the
#              kind and the UTC date of assembly, e.g. "Devnet · 2026-10-24")
#   --remove   delete a network and drop it from the index
#   services.json defaults to the network manifest, packages/opt/docker/services.json
#
# client.toml is copied verbatim: the caller picks the config its clients run.
# The binaries must match the build's checksums.txt, which is extended with the
# network files. Only <out>/<network_id>/ is replaced. Needs bash and coreutils.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
workspace=$(cd "$here/../.." && pwd)
served=$workspace/dist/woodpecker/walletshield/served
out=$here/generated
kind=
name=
remove=
usage='usage: assemble.sh [--served DIR] [--out DIR] [--kind KIND] [--name NAME] <network_id> <client.toml> [<services.json>]
       assemble.sh [--out DIR] --remove <network_id>'

die() {
  echo "assemble: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case $1 in
    --served) served=${2:?$usage}; shift 2 ;;
    --out) out=${2:?$usage}; shift 2 ;;
    --kind) kind=${2:?$usage}; shift 2 ;;
    --name) name=${2:?$usage}; shift 2 ;;
    --remove) remove=1; shift ;;
    -h | --help) echo "$usage"; exit 0 ;;
    -*) die "unknown option $1; $usage" ;;
    *) break ;;
  esac
done
# the clients' NetworkId (libs/rs-core network.rs): one plain lowercase path
# component, not a CLI subcommand; dot names are staging
valid_id() {
  [[ $1 =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] && [[ ! $1 =~ ^(list|connect|help)$ ]]
}

if [ -n "$remove" ]; then
  [ $# = 1 ] || die "$usage"
  valid_id "$1" || die "invalid network id: '$1'"
  [ -d "$out/$1" ] || die "no network $1 in $out"
  rm -rf "${out:?}/$1"
  echo "Removed $out/$1"
  exec "$here/index.sh" --out "$out"
fi

[ $# -ge 2 ] && [ $# -le 3 ] || die "$usage"
network_id=$1
client_config=$2
services=${3:-$workspace/packages/opt/docker/services.json}

valid_id "$network_id" || die "invalid network id: '$network_id'"
if [ -z "$kind" ]; then
  if [ "$network_id" = dev-local ]; then kind=local; else kind=${network_id%%-*}; fi
fi
[[ $kind =~ ^(local|devnet|testnet|mainnet)$ ]] ||
  die "unknown network kind '$kind': pass --kind local|devnet|testnet|mainnet"
created=$(date -u +%FT%TZ)
Kind=$(printf %s "${kind:0:1}" | tr a-z A-Z)${kind:1} # bash 3.2 has no ${kind^}
name=${name:-"$Kind · ${created%%T*}"}
[[ $name =~ ^[^[:cntrl:]]+$ ]] || die "invalid network name: '$name'"
json() { local s=${1//\\/\\\\}; printf '"%s"' "${s//\"/\\\"}"; }
[ -f "$client_config" ] || die "no client config at $client_config"
[ -f "$services" ] || die "no services manifest at $services"
[ -f "$served/checksums.txt" ] ||
  die "no WalletShield export at $served: build it with \`.woodpecker/run dist\`"
(cd "$served" && sha256sum --check --quiet --strict checksums.txt) >&2 ||
  die "the WalletShield binaries in $served do not match their build checksums"

mkdir -p "$out"
staging=$(mktemp -d "$out/.assemble-$network_id.XXXXXX")
trap 'rm -rf "$staging"' EXIT
chmod 755 "$staging"
cp "$client_config" "$staging/client.toml"
cp "$services" "$staging/services.json"
while read -r _ binary; do
  cp -p "$served/$binary" "$staging/$binary"
done <"$served/checksums.txt"
cp "$served/checksums.txt" "$staging/checksums.txt"
(cd "$staging" && sha256sum client.toml services.json >>checksums.txt &&
  sha256sum --check --quiet --strict checksums.txt)
printf '{"id": %s, "kind": %s, "name": %s, "created": %s}\n' \
  "$(json "$network_id")" "$(json "$kind")" "$(json "$name")" "$(json "$created")" \
  >"$staging/network.json"

target=$out/$network_id
previous=$out/.previous-$network_id
rm -rf "$previous"
[ ! -e "$target" ] || mv "$target" "$previous"
mv "$staging" "$target"
rm -rf "$previous"

modified() { date -r "$1" '+%F %T'; }
echo "  client.toml    <- $client_config ($(modified "$client_config"))"
echo "  services.json  <- $services ($(modified "$services"))"
echo "  walletshield-* <- $served ($(modified "$served/checksums.txt"))"
echo "Assembled $target"
"$here/index.sh" --out "$out"
