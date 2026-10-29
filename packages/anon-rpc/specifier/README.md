# @zknet/anon-rpc-specifier

The on-chain half of anon-rpc [SPEC §4](https://github.com/ethereum/anon-rpc/blob/main/SPEC.md)
for the ZKNet anon-rpc worker: a `WorkerSpecifier` contract that pins the worker bundle by
`keccak256` and lists resolvers that serve it, plus the tooling to hash the bundle, check that it
builds reproducibly, serve it content-addressed, and deploy and verify the specifier — on a local
anvil chain, on Sepolia, and on mainnet, each behind a test gate.

Foundry (`forge`, `cast`, `anvil`) and Node built-ins only — no npm dependencies.

## Trust model

`src/WorkerSpecifier.sol` is EF's reference contract, vendored byte for byte (see `NOTICE`), and
compiles to the same runtime code as EF's mainnet deployments (`test/ReferenceBytecode.t.sol`).
It is **owner-updatable**: one stable address tracks worker versions, so the owner key is the
supply chain of every host pinned to it. `renounceOwnership()` freezes it. A harness trusts only
`workerHash()`; resolvers are advisory, and any bytes hashing to the pin are equally good.

## The bundle

Targets take the bundle path as `--bundle <path>` (or `WORKER_BUNDLE`), defaulting to the worker
project's output, `packages/anon-rpc/worker/dist/zknet-anon-rpc-worker.js`. Until that exists, use
EF's passthrough bundle, stored at its content address under `fixtures/keccak/` (`e2e` falls back
to it automatically).

## Targets

| Target                             | What it does                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `compile`                          | `forge build`                                                                                     |
| `test`                             | `test-sol` (forge: upstream tests, bytecode identity, events) and `test-js` (`node --test`)       |
| `fmt-check`                        | `forge fmt --check` over this project's own Solidity (vendored files stay untouched)              |
| `hash`                             | keccak256 of the bundle; writes `dist/worker.keccak256` and `dist/worker.provenance.json`         |
| `reproducible`                     | builds the bundle twice and requires identical bytes (`--clean-export` builds from `git archive`) |
| `resolver`                         | serves the store in the foreground at `http://127.0.0.1:8546/keccak/<hash[0:2]>/<hash[2:]>`       |
| `resolver-put`                     | copies the bundle into the store at its content address and prints its URL                        |
| `resolver-start` / `resolver-stop` | the resolver in the background                                                                    |
| `anvil-start` / `anvil-stop`       | a local chain on `127.0.0.1:8545` in the background                                               |
| `preflight`                        | the deploy gate (see [Deploy tiers](#deploy-tiers)); `deploy` and `publish` depend on it          |
| `publish`                          | puts the bundle where the tier's resolvers serve it from                                          |
| `deploy`                           | deploys the specifier (idempotent), prints its address                                            |
| `verify`                           | reads the specifier back and boot-resolves it as a harness does                                   |
| `verify-source`                    | verifies the deployed source on Sourcify (`test` and `prod`)                                      |
| `e2e`                              | the whole loop on its own ports, then stops everything                                            |
| `demo-up` / `demo-down`            | the backend for trying the worker in the anon-rpc demo site (see `@zknet/anon-rpc-e2e`'s README)  |

Arguments after the target reach the script, e.g.
`nx run anon-rpc-specifier:hash --bundle=fixtures/keccak/19/4f04…`.

`preflight`, `publish`, `deploy` and `verify` take a tier as their Nx configuration —
`deploy:dev` (the default), `deploy:test`, `deploy:prod`. The configuration is a tier, never a
verb: `test` the target runs tests, `deploy:test` deploys to the test tier.

## Local loop

```sh
nx run anon-rpc-specifier:resolver-put
nx run anon-rpc-specifier:resolver-start
nx run anon-rpc-specifier:anvil-start
nx run anon-rpc-specifier:deploy      # prints the specifier address
nx run anon-rpc-specifier:verify
nx run anon-rpc-specifier:anvil-stop
nx run anon-rpc-specifier:resolver-stop
```

Or all of it, against fresh ports, with an idempotency and an update check:
`nx run anon-rpc-specifier:e2e`.

Runtime state (pid files, logs, the resolver store, deployment records) lives in `.state/`
(gitignored).

### Resolver semantics

`GET /keccak/<hash[0:2]>/<hash[2:]>` answers `200` with exactly the bundle bytes — the layout of
EF's `keccak` resolver branch, under the `/keccak` prefix of the SPEC §4.1 kps example. Everything
else is a non-`200`; nothing redirects; there is no `Content-Encoding`, so the body is the bundle
as-is. The server re-hashes each file before serving it, so a corrupted store answers `500`, never
wrong bytes. `Access-Control-Allow-Origin: *` lets browser harnesses fetch it. The reference
harness accepts `http:` resolvers as a development affordance; deployed specifiers use `https:`
and `kps:` entries.

### Deploying

`deploy` hashes the bundle, checks that every `http(s)` resolver serves those exact bytes, then
deploys and reads `workerHash()` / `workerResolvers()` back. The record of the deployment is
`.state/deployments/<chainId>.json`. Re-running with the same bundle and resolvers is a no-op; with
different ones it refuses unless given `--update` (owner `setWorker` on the same address) or
`--fresh` (a new contract). A record whose address has no code (a restarted anvil) is redeployed.

Every chain-facing value is an input, so another chain is configuration:

| Input                          | Default                                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--rpc-url` / `RPC_URL`        | `http://127.0.0.1:8545`                                                                                                                   |
| `--resolver` / `RESOLVER_URLS` | the local resolver URL of the bundle                                                                                                      |
| signer                         | the node's first unlocked account (anvil); or `--account <name>` / `--keystore <path>` with `--password-file <path>` — a Foundry keystore |
| `--deployments`                | `.state/deployments`                                                                                                                      |

`--dry-run` stops before sending anything. The scripts never read, print or pass a raw private key.

## Deploy tiers

| Tier   | Chain                       | Signer                                 | Sends                   | Record                                     |
| ------ | --------------------------- | -------------------------------------- | ----------------------- | ------------------------------------------ |
| `dev`  | local anvil (31337)         | anvil's unlocked account               | yes                     | `.state/deployments/31337.json` (ignored)  |
| `test` | Ethereum Sepolia (11155111) | Foundry keystore, interactive password | only with `--broadcast` | `.state/records/test.json`; posted by hand |
| `prod` | Ethereum mainnet (1)        | Foundry keystore, interactive password | only with `--broadcast` | `.state/records/prod.json`; posted by hand |

A tier fixes its chain in code (`scripts/lib/tiers.mjs`); every script refuses an RPC endpoint
that reports another chain id and prints `tier=<name> chainId=<id>` first. Nx falls back to the
default configuration for a name it does not know, so a mistyped tier (`deploy:mainnet`) runs
`dev`, which can only reach a local chain.

### The gate

`deploy` and `publish` depend on `preflight`, so nothing reaches a chain or a resolver unless the
gate passes. Its cached half is the same for every tier: this project's `compile`, `test`,
`fmt-check` and `lint`, the worker's and transport's `lint`, `typecheck` and `test` (their vitest
configs set `watch: false`, so the gate never waits on a watcher), and the worker build. On top,
`scripts/preflight.mjs --tier` adds:

| Tier   | Adds                                                                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`  | nothing                                                                                                                                                         |
| `test` | the bundle must be what a clean export of `HEAD` builds (`reproducible --clean-export`), so the pinned hash maps to a commit; records `HEAD` and `dirty`        |
| `prod` | `test`, plus an empty `git status --porcelain`, `HEAD` on `main` and on a remote branch, and the posted `deployments/test.json` already pinning the same bundle |

It writes what it proved to `.state/preflight/<tier>.json`; a public-tier `deploy` refuses a
bundle, or a `HEAD`, that the proof does not name.

### Local config (never committed)

A public tier takes its chain-facing values from `deploy.local.json` in this directory, ignored by
git; `deploy.local.example.json` is the template:

```jsonc
{
  "test": {
    "rpcUrl": "https://ethereum-sepolia-rpc.publicnode.com",
    "account": "<keystore name>", // Foundry's default keystore directory
    "deployer": "0x…", // the address that keystore signs as; cast refuses a mismatch
    "resolvers": ["https://<pages project>.pages.dev/keccak/{path}"],
    "pages": { "project": "<pages project>" },
  },
}
```

`{path}` becomes `<hash[0:2]>/<hash[2:]>`. Resolvers are a list, in order; public tiers accept
`https:` entries only. The resolver URLs become public on-chain at deploy; they are kept out of
the code, not secret.

### A `test` cycle

From the repository root:

```sh
nx run anon-rpc-specifier:publish:test           # gate, then stage .state/publish/test; prints the wrangler line
wrangler pages deploy packages/anon-rpc/specifier/.state/publish/test --project-name <pages project> --branch main
nx run anon-rpc-specifier:deploy:test --rehearse  # gate, then the whole deploy on a local fork of Sepolia
nx run anon-rpc-specifier:deploy:test             # gate, then a dry run: chain check, resolver check, plan
nx run anon-rpc-specifier:deploy:test --broadcast # one keystore password prompt; writes .state/records/test.json
nx run anon-rpc-specifier:verify:test             # boot-resolve from Sepolia through the pinned resolvers
nx run anon-rpc-specifier:verify-source:test      # Sourcify, no API key
```

A redeploy of a new bundle is the same lines with `--update` on the `deploy` steps: `setWorker` on
the recorded address, which only its owner can call. `--address <addr>` points any of them at
another existing specifier instead (see [Records](#records)).

- **`publish`** stages a cumulative static site: every bundle ever staged for the tier stays at
  `keccak/<hash[0:2]>/<hash[2:]>`, because a Pages deploy replaces the whole site and older pins may
  still be fetched. `_headers` serves them as `application/octet-stream` with `no-transform`, so
  Cloudflare does not compress them (a resolver must answer without `Content-Encoding`), plus
  immutable caching and CORS. It never runs `wrangler`.
- **`--rehearse`** starts anvil on a fork of the tier's chain, impersonates the configured
  deployer (no key), deploys or updates, reads back, boot-resolves through the fork, and reports
  gas, cost and whether the deployer's real balance covers it. It writes the would-be record to
  `.state/rehearse/<tier>.json` and sends nothing to the real chain. `--resolver <url>` and
  `--deployer <addr>` override the config for a rehearsal (a local resolver before Pages is live; a
  stand-in signer before the keystore exists).
- **`--broadcast`** signs with `--account <name> --from <deployer>`: Foundry asks for the password on
  the terminal, once per transaction; the scripts never see it. A broadcast always checks its
  resolvers and pins exactly the configured ones.

### Records

A public tier keeps two kinds of record, with the same schema:

| Record  | Where                        | Written by                            | In git       |
| ------- | ---------------------------- | ------------------------------------- | ------------ |
| working | `.state/records/<tier>.json` | `deploy --broadcast`, after read-back | no (ignored) |
| posted  | `deployments/<tier>.json`    | you, by copying the working record    | yes, by hand |

Iterating privately on one contract therefore touches nothing in git. **Posting** a deployment
for public consumption is a deliberate step:

```sh
cp packages/anon-rpc/specifier/.state/records/test.json packages/anon-rpc/specifier/deployments/test.json
$EDITOR packages/anon-rpc/specifier/deployments/test.json   # curate updates[], if you like
git add packages/anon-rpc/specifier/deployments/test.json && git commit
```

Which contract a run targets, in order:

1. `--address <addr>`, when given;
2. else the working record, when there is one;
3. else the posted record;
4. else none: a new contract.

Every run prints what it chose — `record <file>: <address> pins <hash>`, `target <addr> (--address;
…)` or `record none yet` — before anything is sent, and notes a posted record that names a
different contract than the working one. Writes always go to the working record; nothing writes
`deployments/`.

`--address` adopts an existing specifier without a record: it must hold the EF reference code and
be owned by the configured deployer, and changing what it pins still needs `--update`. The working
record that results has no `creation` (the chain has it; nothing here needs it). This is also how
to switch contracts: `--address` once with `--broadcast`, and the working record names it from then
on.

```jsonc
{
  "tier": "test",
  "chainId": 11155111,
  "address": "0x…",
  "contract": "WorkerSpecifier",
  "codehash": "0xc4c54384…7b5f",
  "owner": "0x…",
  "creation": { "tx": "0x…", "block": 0 }, // absent when started from --address
  "workerHash": "0x…",
  "bundle": { "file": "zknet-anon-rpc-worker.js", "bytes": 0, "gitCommit": "…", "dirty": false },
  "updates": [{ "tx": "0x…", "block": 0, "workerHash": "0x…", "gitCommit": "…" }],
}
```

A record never holds a URL; writing one fails. `updates` is informational and meant to be curated
by hand before posting: prune test noise, keep what matters. No tooling reads it. Everything works
from the top-level fields, with `updates` missing or empty.

### What a complete redeploy updates

1. **The resolver-hosted bundle** — `publish:<tier>` and the `wrangler pages deploy` upload; later,
   any other resolver in the list (e.g. a `keccak` branch on `raw.githubusercontent.com`).
2. **The specifier on chain** — `deploy:<tier> --broadcast` (`--update` for a new bundle).
3. **The posted record** — `deployments/<tier>.json`, copied from the working record, curated,
   committed — only when the deployment is for public consumption.
4. **Source verification** — `verify-source:<tier>`, once per new contract.
5. **ZKNet's entry in upstream anon-rpc `adopters.json5`** — `specifier` and `chainId` of the
   live address, by pull request against that file, when the address changes (a `setWorker` keeps
   it).
6. **The exit's network routes** — only if the worker should reach a network the exit does not yet
   route (`rpc_proxy_config.toml`).

## Reproducibility

The pinned hash is only meaningful if anyone can rebuild the same bytes from the same commit.
`reproducible` builds the bundle twice (`WORKER_BUILD_CMD`, default
`pnpm nx run anon-rpc-worker:build --skip-nx-cache`) and fails on any difference, naming
the first differing byte. `--clean-export` builds each run from a fresh `git archive` of `--ref` at
paths of different lengths, after `pnpm install --frozen-lockfile`, which also catches leaks of the
build path and of untracked files. `--ref WORKTREE` exports what committing the working tree would
capture instead, to check work before it is committed.

## Requirements

Foundry, found on `PATH`, in `FOUNDRY_BIN`, or in foundryup's `~/.foundry/bin`; Node 22 or later.
