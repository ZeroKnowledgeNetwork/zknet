# @zknet/anon-rpc-worker

An [anon-rpc](https://github.com/ethereum/anon-rpc) worker that serves
Ethereum JSON-RPC through ZKNet. It hands each request body to the user's
local **WalletShield** (the ZKNet client's HTTP listener), which carries it
through the mixnet to an exit. The worker then relays the upstream reply back
as the `fetch` response.

The worker is one hash-pinned file. A host loads it through an anon-rpc
harness by its specifier contract, and the file's keccak256 is the identity
the contract pins (Anon-RPC SPEC v0.3.2 §4).

## Which RPC: the URL decides

Anon-RPC SPEC v0.3.2 §3.2 lets a worker enable Ethereum RPC by general web
request access, by serving RPC at a nominated special URL, or both. This
worker does both. The URL the host passes to `worker.fetch(url, init)` (the
anon-rpc demo's _Worker RPC URL_) chooses:

| URL                                                                                                                                                               | who answers                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WalletShield's own URL**: the `walletshield` origin plus an exit network key, e.g. `http://127.0.0.1:7070/ethereum` or `http://127.0.0.1:7070/ethereum/sepolia` | the exit operator's provider for that key (the exit's `[Networks]`), exactly as WalletShield answers any wallet                                                                   |
| **any other public `https:` URL**, e.g. `https://ethereum-rpc.publicnode.com`                                                                                     | that provider. The exit fetches it under its destination policy: `https` only, public addresses only (checked after DNS resolution), no redirects followed, size and time limits. |

What ZKNet offers is **RPC provider selection, not general web access**:
only JSON-RPC `POST` is served. A provider URL may carry an API key; it
never appears in a request line, and no log on the way records more than its
host, except WalletShield's own DEBUG log on your machine. The URL, key
included, is encrypted across the mixnet and visible to the exit operator who
fetches it.

```sh
pnpm nx build @zknet/anon-rpc-worker   # → dist/zknet-anon-rpc-worker.js, prints its keccak256
pnpm nx test @zknet/anon-rpc-worker    # unit tests (stub WalletShield) + byte-stability
```

The build is byte-stable: the same sources and the same esbuild version give
the same bytes from any working directory. That is why `esbuild` is pinned
exactly at the workspace root.

## Config (`WorkerInit.config`)

Every key is optional. An unknown key, a wrong type, or a peer that is not
local makes the worker call `signalFailed({ code: 'bad-config' })`.

| key            | default                 | meaning                                                                                                                                                                                                                          |
| -------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `walletshield` | `http://127.0.0.1:7070` | WalletShield's listener. It must be loopback or local network (see `@zknet/anon-rpc-transport`'s `targets.ts`). `:7070` is the usual port, but WalletShield has no built-in default, so set this key if yours listens elsewhere. |
| `timeoutMs`    | `30000`                 | Per-request deadline. Keep it above WalletShield's own `-timeout` (20 s) so that its `mix-timeout` is reported first.                                                                                                            |
| `logLevel`     | `info`                  | The lowest level forwarded to the harness log                                                                                                                                                                                    |

## Local network access (host side)

On a public page, Chromium lets the worker reach WalletShield only when two
things are true:

- **The host delegates local network access to the worker's frame.** With the
  anon-rpc browser harness, pass `network.policy` with the address spaces the
  worker needs. This field is PROPOSED upstream; it is not in Anon-RPC SPEC v0.3.2.
  `"loopback"` delegates loopback and `"local"` delegates the LAN. Both cover
  a whole space, not single addresses. For ZKNet:

  ```ts
  new AnonRpcWorker({
    address,
    preExisting,
    config: { walletshield: "http://127.0.0.1:7070" },
    network: { policy: { allow: ["loopback", "local"] } },
  });
  ```

- **The user has granted the page Local Network Access.** Delegation alone
  only lets the prompt happen.

A page served from loopback is not gated at all.

Mixed content behaves differently per browser:

- **Chromium (154)** exempts `http:` requests to private IP literals and
  `.local` names. An `http:` LAN WalletShield is therefore reachable from an
  `https:` page.
- **Firefox (157)** blocks them as mixed content. **An `https:` page reaches
  a LAN WalletShield only if WalletShield serves `https:`.** Loopback is
  unaffected in both browsers.

The worker sends no `targetAddressSpace` fetch option. Chromium needs it only
for a public host name that resolves to a local address, which the worker
refuses anyway. Chromium also rejects any fetch naming it once that fetch
goes through a browser proxy.

## Reply and failure contract

- **Success.** The worker relays a successful exit round trip **truthfully**:
  the upstream status, the allowlisted headers (`content-type`,
  `retry-after`) and the body. An upstream 429 reaches the host as a 429
  response, not a rejection.
- **Failure.** A call fails by rejecting. The harness forwards
  `{ name, message, code }`:
  - **`code`** is the Anon-RPC SPEC v0.3.2 §12 value.
  - **`name`** is a **stable** finer reason. Both are contract.
  - `message` is diagnostic only.

| `code`              | `name`                | when                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsupported`       | `UnsupportedRequest`  | the method is not `POST`; the URL is not absolute, carries credentials or a fragment, is `http:` (and not WalletShield's), is a local address other than the configured WalletShield, or is a WalletShield path that is not a network key                                                                                                                        |
| `too-large`         | `TooLarge`            | the request body (over 128 KiB) or the URL (over 2 KiB) is past the limits in `src/lib/limits.ts`, refused before sending                                                                                                                                                                                                                                        |
| `network-error`     | `PeerUnreachable`     | nothing readable came back from WalletShield's address. Either it is not running there, or the browser refused local network access (not delegated or not granted). A worker cannot tell these apart, because the browser reports one `TypeError` for both. The host can: it knows its own delegation and can query `loopback-network` / `local-network` itself. |
| `permission-denied` | `CorsRejected`        | something answered at WalletShield's address, but its reply is unreadable from the worker's origin (CORS)                                                                                                                                                                                                                                                        |
| `unsupported`       | `MixedContentBlocked` | the peer is an `http:` LAN address and the worker runs in a secure context. Predicted, never probed; Firefox is the browser that blocks this.                                                                                                                                                                                                                    |
| `timeout`           | `MixTimeout`          | WalletShield reports that no reply came back over the mixnet in time (`ZKNet-Error: mix-timeout`)                                                                                                                                                                                                                                                                |
| `permission-denied` | `ExitRefused`         | the exit refused the request: a network key it does not serve, a provider URL its destination policy refuses, or provider selection turned off by its operator (`provider-selection-off`). Nothing went upstream.                                                                                                                                                |
| `queue-full`        | `ExitBusy`            | the exit was already serving its maximum number of requests                                                                                                                                                                                                                                                                                                      |
| `network-error`     | `UpstreamUnreachable` | the exit could not complete the upstream request                                                                                                                                                                                                                                                                                                                 |
| `too-large`         | `TooLarge`            | the request or the reply does not fit the mixnet payload                                                                                                                                                                                                                                                                                                         |
| `protocol-error`    | `BadReply`            | WalletShield could not decode the exit's reply                                                                                                                                                                                                                                                                                                                   |
| `protocol-error`    | `UnexpectedReply`     | a `ZKNet-Error` reason this worker does not know, or a reply that was redirected on the way from WalletShield                                                                                                                                                                                                                                                    |
| `network-error`     | `RedirectRefused`     | the provider answered with a redirect and the call's `redirect` is `error`. The exit never follows a redirect: under `follow` or `manual` the 3xx is the response.                                                                                                                                                                                               |
| `timeout`           | `Deadline`            | `timeoutMs` passed first                                                                                                                                                                                                                                                                                                                                         |
| `cancelled`         | `AbortError`          | the host aborted the call                                                                                                                                                                                                                                                                                                                                        |
| `internal-error`    | `InternalError`       | a bug                                                                                                                                                                                                                                                                                                                                                            |

The rows from `MixTimeout` to `UnexpectedReply` are replies marked with the
`ZKNet-Error` header (a redirected reply aside). A reply without that header is the upstream's reply,
whatever its status.

`signalFailed` codes are permanent: this bundle cannot run here. There are
two:

- **`bad-config`**: an unknown key, a wrong type, or a peer that is not
  local.
- **`unsupported-platform`**: no `fetch`, `AbortSignal.any` or
  `AbortSignal.timeout`.

A WalletShield that is down is **not** a `signalFailed`. The worker becomes
ready regardless, because the user may start WalletShield later, while a
`signalFailed` is final.

## Logs (`anonRpcWorker.log`)

Each entry is `("zknet-worker", event, fields?)`, where `fields` is a flat
object of primitives.

| level       | event                                                | fields                                                                             |
| ----------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| info        | `boot.start`                                         | `version`                                                                          |
| info        | `boot.config`                                        | `peer`, `target` (`loopback`/`lan`), `timeoutMs`                                   |
| info        | `ready`                                              | —                                                                                  |
| info / warn | `probe`                                              | `reach` (`none`/`peer`/`exit`), `ms`, `version?`, `code?`, `name?`                 |
| debug       | `call.done`                                          | `seq`, `ms`, `route` (`network`/`url`), `outcome`, `status`, `bytesOut`, `bytesIn` |
| warn        | `call.refused`                                       | `seq`, `reason` (`url`/`method`/`size`)                                            |
| warn        | `call.failed`                                        | `seq`, `route`, `code`, `name`, `ms`                                               |
| debug       | `call.ignored`                                       | `kind`                                                                             |
| error       | `accept.failed` · `respond.failed` · `worker.failed` | `code?`, `reason`                                                                  |

The worker probes WalletShield at boot and after a failed call, at most once
every 10 s. The probe uses `GET /_/health`, which WalletShield answers
locally; it never sends a mixnet packet. The logs never carry:

- WalletShield's address;
- URLs;
- bodies;
- JSON-RPC methods or params.

Free text from errors is redacted.

## Layout

```
src/worker.ts          bundle entry (IIFE): wires the global anonRpcWorker to runWorker()
src/lib/core.ts        accept loop, route() (the URL table above), refusals, failure mapping, probes
src/lib/config.ts      the config schema above
src/lib/limits.ts      request-body and URL limits, matching the exit's
src/lib/log.ts         the log format above, redaction
src/lib/spec-types.ts  worker-facing Anon-RPC SPEC v0.3.2 types, a copy (a worker carries its own)
build.mjs              esbuild → dist/zknet-anon-rpc-worker.js + keccak256
```

The transport (WalletShield now, kpclientd next) lives in
[`@zknet/anon-rpc-transport`](../transport) and is bundled in.
