# zknetwork source

ZKNetwork's [Nx](https://nx.dev) monorepo contains the `packages/opt` Go module:
WalletShield, the `rpc_proxy` CBOR plugin, and the local Katzenpost mixnet tooling.
The projects below build and exercise the client → mixnet → RPC path.

```sh
pnpm install
pnpm nx show projects
```

## Projects

Four Nx projects define the active Go and Make workflows:

| Project        | Root                                                 | Targets                                                                              |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `opt-common`   | `packages/opt/common`                                | `test`                                                                               |
| `rpc-proxy`    | `packages/opt/server_plugins/cbor_plugins/rpc_proxy` | `build`                                                                              |
| `walletshield` | `packages/opt/apps/walletshield`                     | `build`, `dev-remote`                                                                |
| `mixnet`       | `packages/opt/docker`                                | `start`, `ready`, `probe`, `serve`, `e2e-rpc`, `e2e-rpc-matrix`, `stop`, `dev-local` |

The clients run against that mixnet through `network-assets` (`apps/network-assets`:
`stage`, `serve`, `ready`, `test`), which assembles a network's assets in the clients' download
layout and serves them to `zknet_client_cli:dev-local` and `@zknet/client:desktop-dev-local`.
See [Run the clients locally](#run-the-clients-locally).

`rpc-proxy` is one project for a library plus its `cmd/rpc_proxy` binary, not one per
file.

The [anon-rpc](https://github.com/ethereum/anon-rpc) worker, which lets a wallet send RPC
through ZKNet from a browser, lives in `packages/anon-rpc`:

| Project                     | Root                          | Targets                                                                                                                              |
| --------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `@zknet/anon-rpc-transport` | `packages/anon-rpc/transport` | `test`, `typecheck`                                                                                                                  |
| `@zknet/anon-rpc-worker`    | `packages/anon-rpc/worker`    | `build`, `test`, `typecheck`                                                                                                         |
| `@zknet/anon-rpc-specifier` | `packages/anon-rpc/specifier` | `compile`, `test`, `hash`, `reproducible`, `resolver-start`, `resolver-stop`, `anvil-start`, `anvil-stop`, `deploy`, `verify`, `e2e` |
| `@zknet/anon-rpc-e2e`       | `packages/anon-rpc/e2e`       | `e2e`, `e2e-fork`, `live`                                                                                                            |

Each has a README with the details.

### Nx wraps the existing Make targets — it does not replace them

Every target is `nx:run-commands` around a recipe that already exists:

- `opt-common:test` → `go test ./...` in `packages/opt/common`.
- `rpc-proxy:build` → `make rpc_proxy` in `packages/opt` (the module `Makefile`,
  which carries the `-ldflags -X …/common.CompressionEnabled` build flag).
- `walletshield:build` → `make app-walletshield` in `packages/opt`.
- every `mixnet:*` target → `make -e <target>` in `packages/opt/docker`, the thin
  wrapper that passes through to the pinned Katzenpost `docker/Makefile`. `-e` is what
  lets you override the wrapper's own variables from the environment.

There is no Go Nx plugin and no generated graph parser. Consequently the Go dependency
edges are declared by hand with `implicitDependencies`
(`walletshield → opt-common, rpc-proxy`; `rpc-proxy → opt-common`; `mixnet → all
three`) and must be updated if the Go imports change.

### Caching

The three `build`/`test` targets are cacheable and declare `inputs` (project `*.go`,
`^default` for dependencies, and the `optModule` named input: `packages/opt/go.mod`,
`go.sum` and `Makefile`) plus `outputs` for the two binaries. Every `mixnet:*` target
sets `"cache": false` — its real output is host and Docker daemon state, which a cache
cannot restore.

`build`/`test` do **not** `dependsOn` each other: `go build` resolves the sibling
packages from source, and the mixnet build compiles its own binaries inside the build
container. Ordering is only declared where it is actually required
(`walletshield:dev-remote → walletshield:build`, and the `mixnet:dev-local` chain).

## Build and test

```sh
pnpm nx run-many -t build,test       # all Go projects
pnpm nx affected -t build,test       # only what a change touches
pnpm nx run walletshield:build
```

CI checks and distribution builds (WalletShield and the CLI for four platforms,
the Linux desktop bundles) run locally on Woodpecker; see
[`.woodpecker/README.md`](.woodpecker/README.md):

```sh
.woodpecker/run ci
.woodpecker/run dist
```

## Run the local mixnet

Brings up a pinned local Katzenpost testnet (version read from `packages/opt/go.mod`),
injects the `rpc_proxy` plugin into its single service node, and runs WalletShield
against it.

```sh
pnpm nx run mixnet:dev-local         # = start → ready → serve, in order
```

or step by step, which is what `dev-local` runs:

```sh
pnpm nx run mixnet:start             # clone Katzenpost if needed, build, compose up (~5 min cold)
pnpm nx run mixnet:ready             # bounded readiness: upstream `wait`, under `timeout` (~1 min)
pnpm nx run mixnet:probe             # WalletShield mixnet round-trip probe
pnpm nx run mixnet:serve             # WalletShield client, listening on :7070
pnpm nx run mixnet:e2e-rpc           # the clients' services.json paths through the proxy to real RPC
pnpm nx run mixnet:e2e-rpc-matrix    # diagnostic sweep of all configured RPC fixtures
pnpm nx run mixnet:stop              # stop the client and the compose project
```

`mixnet:ready` wraps upstream's own `wait` (which fetches until the PKI document is
ready) inside `timeout ${ready_timeout:-900}`. It is a real probe with a bound, not a
sleep. Nothing here relies on Nx `continuous: true`, which signals neither readiness nor
container teardown.

**`mixnet:stop` is the teardown.** It stops only what these targets own: the
`walletshield` container and the compose project of the Katzenpost checkout in use.

**Prerequisites:** `docker` (or `podman`), `make`, `git`, `go`, and — for the port guard
upstream runs as part of `start` — `ss` (`iproute2`). `e2e-rpc` and
`e2e-rpc-matrix` additionally need `curl` and `jq`. Both reach live public RPC
endpoints. `e2e-rpc` is the representative transport gate; `e2e-rpc-matrix` runs
the full provider/chain fixture set and is diagnostic only. Providers, networks,
and recorded responses can change independently of this code, so matrix failures
are not a CI gate.

### One mixnet per host

`mixnet:serve` uses the wrapper's fixed container name `walletshield` and listener
`:7070`, and the testnet reserves a port band derived from `base_port`. Run one local
mixnet per host. To run against a Katzenpost checkout and port band other than the
defaults — for example to keep a second developer's stack off someone else's — override
through the environment, which is why the targets use `make -e`:

```sh
env katzenpost_dir=/tmp/katzenpost.mine distro=debian-trixie base_port=52000 \
  pnpm nx run mixnet:start
```

`distro` selects the base image tag (`katzenpost-$(distro)_base`), so changing it also
avoids retagging an image someone else built. The default is `alpine`.

> ⚠️ `make -n` is **not** a dry run here. The wrapper's pass-through rule invokes
> `$(MAKE)`, which GNU make executes even under `-n`, and `clone-katzenpost` really
> clones. Likewise `make clean` runs `rm -rf $(katzenpost_dir)` — it deletes the
> Katzenpost checkout, which is why no Nx target wraps it.

## Run the clients locally

With the local mixnet running (`mixnet:start`, `mixnet:ready`) and a current WalletShield
dist (`.woodpecker/run dist`), each client target stages and serves that network's assets
on `127.0.0.1:8765` and launches the client with it as its source. `dev-local` publishes a
thin client config, so WalletShield dials the host-exposed client daemon:

```sh
pnpm nx run zknet_client_cli:dev-local -- connect dev-local   # headless; WalletShield on :7070
pnpm nx run zknet_client_cli:dev-local -- list                # every known network, with its source
pnpm nx run @zknet/client:desktop-dev-local                   # desktop; connect to network id `dev-local`
```

Once connected, `dev-local` is known to the client and connects at its own source from any
launch, e.g. `pnpm nx run zknet_client_cli:run -- connect dev-local`.

Ctrl-C stops the client, its WalletShield and the asset server. Here the asset server is
an Nx `continuous` task, which suits a plain process: the dependents' explicit `ready` probe
supplies the readiness gate Nx lacks. Details: `apps/network-assets/README.md`.

For the browser path, keep the desktop client connected, build the extension with
`pnpm nx run @zknet/ext:build`, load `apps/ext/.output/chrome-mv3/` as an unpacked
extension in a Chromium development profile, and run `pnpm nx run @zknet/demo:serve`.
Exercise a demo RPC request and observe the response through the SDK → extension →
desktop control API → WalletShield. This is a local integration check, not proof
of a deployed mixnet or signed distribution.

## Run against a remote mixnet

```sh
env remote_client_config=/path/to/client.toml pnpm nx run walletshield:dev-remote
```

`dev-remote` runs only the WalletShield binary. It has no dependency on any `mixnet:*`
target, so it cannot start, mutate or tear down a local topology, and
`remote_client_config` is required — unset, the target fails instead of silently
defaulting. `ws_listen` (default `:7070`), `log_level` and `ws_extra_flags` are optional
overrides.

**Browser callers.** WalletShield answers CORS preflights itself and never sends them over
the mixnet. It allows every origin (`Access-Control-Allow-Origin: *`), including `null`
(sandboxed frames such as an anon-rpc worker), so any website you visit can use and read
this local proxy. Restricting origins is future work.

## Conventions

- Run tasks through Nx (`pnpm nx run`, `run-many`, `affected`) rather than the
  underlying tooling, and prefix with `pnpm` to use the pinned CLI.
- `packages/opt` is a **nested Go module**. There is no `go.mod` at the workspace root,
  and the module path `github.com/ZeroKnowledgeNetwork/opt` is load-bearing in both
  imports and `-ldflags -X` build flags — do not rename or re-root it.
- See `AGENTS.md` for the Nx skills and agent guidance that apply to this workspace.
- To move to a new upstream Katzenpost tag, follow
  [`packages/opt/UPGRADING.md`](packages/opt/UPGRADING.md).

## Other source paths

`packages/opt/pki/` and `genconfig/` remain in the Go module, but are outside
the current Nx project graph and voting-mixnet development path. The
`docker/node/` and `docker/qemu-runner/` directories have no Nx targets here.
`packages/opt/tests/` holds the RPC fixtures used by `mixnet:e2e-rpc` and
`mixnet:e2e-rpc-matrix`; a separate project is unnecessary for those scripts.

## License

`AGPL-3.0-only` by default, with `packages/anon-rpc/` under MIT. See
[`LICENSING.md`](LICENSING.md) for the path map and where each license text lives.
