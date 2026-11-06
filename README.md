# ZKNetwork

Privacy-first decentralized infrastructure for sovereign coordination. Post-quantum mixnets, zero-knowledge cryptography, and tamper-resistant edge hardware, forged into one modular substrate.

WalletShield is the first app on ZKNet: a local RPC endpoint for wallets that carries
their blockchain RPC requests, for Ethereum and other chains, through the
[Katzenpost](https://katzenpost.network) mixnet to an exit that forwards them to an RPC
provider, so the provider sees the request but not who sent it. The desktop and
command-line clients run it for you.

> **ZKNet is beta software.** Expect breaking changes between releases.

**Download** the desktop client, the `zknet` CLI or WalletShield from this repository's
[Releases](../../releases) page.

The rest of this README is for building ZKNet from source.

## Source

An [Nx](https://nx.dev) monorepo with pnpm, a Go module (`packages/opt`) and a Cargo
workspace:

```sh
pnpm install
pnpm nx show projects                    # every project
pnpm nx show project <project>           # its root and every target
```

## Projects

Each project's targets, including those Nx plugins infer: `pnpm nx show project <project>`.

### Clients — Rust and TypeScript

| Project          | Root                    | What it is                                                                                      |
| ---------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `client`         | `apps/client`           | The desktop client (Tauri): its React UI and the desktop build and run targets                  |
| `client-cli`     | `apps/client-cli`       | `zknet`, the command-line client                                                                |
| `client-core`    | `libs/client-core`      | Rust library both clients share: network discovery, asset download and signature checks, config |
| `client-tauri`   | `apps/client/src-tauri` | The desktop client's Rust side, including the local control API the browser extension uses      |
| `network-assets` | `apps/network-assets`   | Assembles a network's client assets in the layout the clients download, and serves them locally |

### Mixnet — Go, `packages/opt`

| Project            | Root                                                 | What it is                                                                       |
| ------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `mixnet`           | `packages/opt/docker`                                | A local Katzenpost testnet with `rpc-proxy` installed, and its end-to-end tests  |
| `app-walletshield` | `packages/opt/apps/walletshield`                     | WalletShield: the local HTTP RPC listener that sends requests through the mixnet |
| `rpc-proxy`        | `packages/opt/server_plugins/cbor_plugins/rpc_proxy` | The mixnet exit: a Katzenpost CBOR service plugin that forwards RPC requests     |
| `opt-common`       | `packages/opt/common`                                | Shared Go code for the client and the exit: payload compression                  |

`rpc-proxy` is one project for a library plus its `cmd/rpc_proxy` binary.

### Browser — TypeScript

| Project    | Root            | What it is                                                                                            |
| ---------- | --------------- | ----------------------------------------------------------------------------------------------------- |
| `ext`      | `apps/ext`      | Browser extension that gives web pages `window.zknet` and relays their requests to the desktop client |
| `sdk`      | `packages/sdk`  | `@zknet/sdk`: detects the extension and sends a page's requests through it                            |
| `sdk-demo` | `apps/sdk-demo` | A demo web page for the SDK                                                                           |

### anon-rpc — TypeScript and Solidity, `packages/anon-rpc`

An [anon-rpc](https://github.com/ethereum/anon-rpc) worker, which lets a wallet send RPC
through ZKNet from a browser. Each project has a README with the details.

| Project              | Root                          | What it is                                                                                            |
| -------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `anon-rpc-worker`    | `packages/anon-rpc/worker`    | The worker bundle that serves Ethereum JSON-RPC through ZKNet                                         |
| `anon-rpc-transport` | `packages/anon-rpc/transport` | The worker's connection to the local WalletShield                                                     |
| `anon-rpc-specifier` | `packages/anon-rpc/specifier` | The on-chain `WorkerSpecifier` that pins the worker bundle, with hashing, resolver and deploy tooling |
| `anon-rpc-e2e`       | `packages/anon-rpc/e2e`       | End-to-end tests of the worker in a headless browser                                                  |

## Build and test

```sh
pnpm nx run-many -t build,test       # every project
pnpm nx affected -t build,test       # only what a change touches
pnpm nx run app-walletshield:build
```

CI runs `pnpm nx format:check` and `pnpm nx run-many -t lint test build typecheck`.
The CI and distribution pipelines (WalletShield, the `zknet` CLI and the Linux desktop
bundles) run on Woodpecker's local docker backend. The GitHub workflows in
`.github/workflows/` run the same pipelines, plus the local mixnet's `e2e-rpc`; see
[`.woodpecker/README.md`](.woodpecker/README.md):

```sh
.woodpecker/run ci
.woodpecker/run dist
```

[`release/README.md`](release/README.md) describes the release tags and assets.

### The Go projects wrap the existing Make targets

The Go targets are `nx:run-commands` around recipes that already exist:

- `opt-common:test` → `go test ./...` in `packages/opt/common`.
- `rpc-proxy:build` → `make rpc_proxy` in `packages/opt` (the module `Makefile`,
  which carries the `-ldflags -X …/common.CompressionEnabled` build flag).
- `app-walletshield:build` → `make app-walletshield` in `packages/opt`.
- `app-walletshield:test` → `go test ./...`, plus the tests of `packages/opt/served.sh`
  (WalletShield's export in the clients' download layout).
- `app-walletshield:dist` → `packages/opt/dist.sh`, a goreleaser build
  (`--configuration=dev` by default).
- `mixnet:start`, `ready`, `probe`, `serve` and `stop` → `make -e …` in
  `packages/opt/docker`, the thin wrapper that passes through to the pinned Katzenpost
  `docker/Makefile`. `-e` is what lets you override the wrapper's own variables from the
  environment.
- `mixnet:e2e-rpc` and `e2e-rpc-matrix` → the scripts in `packages/opt/tests/e2e/walletshield`.

There is no Go Nx plugin. The Go dependency edges are declared by hand with
`implicitDependencies` (`app-walletshield → opt-common, rpc-proxy`;
`rpc-proxy → opt-common`; `mixnet → all three`) and must be updated if the Go imports
change.

### Caching

The four Go `build`/`test` targets are cacheable and declare `inputs` (project `*.go`,
the `optModule` named input — `packages/opt/go.mod`, `go.sum` and `Makefile` — and
`^default` where the project has dependencies; `app-walletshield:test` adds the files its
`served.sh` tests read) plus `outputs` for the two binaries. Every `mixnet:*` target
sets `"cache": false` — its real output is host and Docker daemon state, which a cache
cannot restore.

The Go `build`/`test` targets do **not** `dependsOn` each other: `go build` resolves the
sibling packages from source, and the mixnet build compiles its own binaries inside the
build container. Ordering is declared only where it is required:
`app-walletshield:dev-remote → app-walletshield:build`, and
`client-cli:dev-local` / `client:desktop-dev-local → network-assets:serve → network-assets:stage`.

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
pnpm nx run client-cli:dev-local -- connect dev-local   # headless; WalletShield on :7070
pnpm nx run client-cli:dev-local -- list                # every known network, with its source
pnpm nx run client:desktop-dev-local                   # desktop; connect to network id `dev-local`
```

Once connected, `dev-local` is known to the client and connects at its own source from any
launch, e.g. `pnpm nx run client-cli:run -- connect dev-local`.

Ctrl-C stops the client, its WalletShield and the asset server. Here the asset server is
an Nx `continuous` task, which suits a plain process: the dependents' explicit `ready` probe
supplies the readiness gate Nx lacks. Details: `apps/network-assets/README.md`.

For the browser path, keep the desktop client connected, build the extension with
`pnpm nx run ext:build`, load `apps/ext/.output/chrome-mv3/` as an unpacked
extension in a Chromium development profile, and run `pnpm nx run sdk-demo:serve`.
Exercise a demo RPC request and observe the response through the SDK → extension →
desktop control API → WalletShield. This is a local integration check, not proof
of a deployed mixnet or signed distribution.

## Run against a remote mixnet

```sh
env remote_client_config=/path/to/client.toml pnpm nx run app-walletshield:dev-remote
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
