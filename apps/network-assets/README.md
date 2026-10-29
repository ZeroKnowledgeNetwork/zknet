# network-assets

Assembles a network's client assets in the layout the clients download, indexes the
networks it holds, and serves them on loopback for development:

```
generated/_headers, generated/404.html   Cloudflare Pages: revalidate the index, real 404s
generated/networks/networks.json         the index of live networks (clients' `list`)
generated/networks/<network_id>/{client.toml,services.json,walletshield-<platform>,
                                 checksums.txt,checksums.txt.minisig,network.json}
```

`generated/` is the published root and `generated/networks/` is the clients' network
source: `https://dist.zknet.io/networks` when published, `http://127.0.0.1:8765` locally.
The clients read this layout through one contract, `zknet_client_core::network` in
`libs/client-core`.

It only collects. Whether the mixnet is running is the concern of `mixnet:ready` and the
clients; what the binaries are and how they are built is the concern of `app-walletshield:dist`.

## Assemble

`assemble.sh` needs bash and coreutils only, so it runs on a host without Nx or Node, for
example one that runs the mixnet with docker and make and reads the dist from a shared
filesystem:

```sh
apps/network-assets/assemble.sh [--served DIR] [--out DIR] [--kind KIND] [--name NAME] \
  <network_id> <client.toml> [<services.json>]
apps/network-assets/assemble.sh [--out DIR] --remove <network_id>
```

| Input           | Default                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `--served`      | `dist/woodpecker/walletshield/served`: the export of `.woodpecker/run dist`   |
| `--out`         | `apps/network-assets/generated`: the published root                           |
| `--kind`        | `local` for `dev-local`, else the id's prefix: `devnet`, `testnet`, `mainnet` |
| `--name`        | `<Kind> · <YYYY-MM-DD>` (UTC date of assembly): the name clients show         |
| `services.json` | `packages/opt/docker/services.json`, the network's service manifest           |

- `client.toml` is copied verbatim: the caller picks the config its clients run.
- The binaries must match the build's `checksums.txt`. It is published as it is, with its
  signature `checksums.txt.minisig`, by the asset key: the
  clients run a binary only if the signature is by the key in `libs/client-core/asset-key.pub`
  and the binary's hash is the one it lists. Every kind but `local` needs the signature;
  assembly checks only that it is there, and the clients verify it.
- Only `<out>/networks/<network_id>/` is replaced, so networks assembled side by side stay
  as they are. `<out>` is the directory to publish.
- A network id is one lowercase path component, `^[a-z0-9][a-z0-9._-]{0,63}$`, and not
  `list`, `connect` or `help` (the CLI's subcommands): the clients' `NetworkId` rule.
- `networks/<network_id>/network.json` holds the network's index entry (`id`, `kind`,
  `name`, `created`). `index.sh [--out DIR]`, run by every assembly and removal, rebuilds
  `networks/networks.json` from those files, newest first, so a network is listed exactly
  while its directory exists.

`fixtures/networks.json` is the clients' sample index. The index test compares its
parsed JSON with `index.sh` output, including network order; the fixture may use
the repository's JSON formatting without changing the published index format.

## Publish

`<out>` is a complete static site. Each deploy replaces the whole site, so removing a
network and redeploying unpublishes its assets and its index entry together. Pages caps
one file at 25 MiB, and serves a single-page fallback (the root, with status 200) for
missing paths unless the site has a `404.html`; `index.sh` writes one.

## Run the clients against the local mixnet

```sh
.woodpecker/run dist                                   # after committing any change under packages/opt
pnpm nx run mixnet:start && pnpm nx run mixnet:ready   # once, if no local mixnet is running
pnpm nx run client-cli:dev-local -- connect dev-local   # headless client on :7070
pnpm nx run client:desktop-dev-local            # desktop; connect to network id `dev-local`
```

Each client target stages, serves, waits for `ready`, then starts the client. Ctrl-C (or
closing the desktop) stops the client, its WalletShield and the server. Two client targets
running at once share one server.

| Target  | Does                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------ |
| `stage` | `assemble.sh dev-local` with the local mixnet's thin-client config (`katzenpost_dir`, `distro` as in its Makefile) |
| `serve` | Serves `generated/networks/` on `127.0.0.1:8765`: an Nx continuous task, stopped by Ctrl-C or its dependent        |
| `ready` | Waits until the server returns the `dev-local` bytes; fails if nothing or something else answers                   |
| `test`  | Assembly, server and client-contract tests (`python3 -m unittest`)                                                 |

`dev-local` publishes the thin-client config under the clients' `client.toml` name:
WalletShield recognises a thin config and dials the host-exposed `kpclientd`, while the
full config names container hosts the host cannot resolve. No client flag picks the mode,
so `dev-local` connects from any launch once a client knows it. Re-staging gives it a new
`created`, so clients download the rebuilt WalletShield instead of their cached copy; the
binary itself must come from a `.woodpecker/run dist` that includes WalletShield's mode
inference, or a thin config without `-thin` fails to load.

The server never stops a process it did not start. If `:8765` is taken, `serve` fails and
names the port. WalletShield listens on the client's configured `:7070`, so free that port
first if `mixnet:serve` is running.
