# @zknet/anon-rpc-e2e

End-to-end tests of the ZKNet anon-rpc worker, loaded the way a wallet loads it:

```
headless Chromium (Playwright)
  host page (page/main.ts) with @anon-rpc/browser-harness
    reads a WorkerSpecifier on a local anvil, fetches the bundle from the keccak resolver,
    checks keccak256, boots the worker in the harness's sandboxed frame
      worker → POST /<network> or POST /_/url → WalletShield (a stub here; the real one in the live tier)
```

The specifier, the anvil chain and the resolver come from `@zknet/anon-rpc-specifier`. The
bundle is the real `packages/anon-rpc/worker/dist/zknet-anon-rpc-worker.js`; every target
builds it first.

## Tiers

| Target     | Tier            | Runs                                                                    |
| ---------- | --------------- | ----------------------------------------------------------------------- |
| `e2e`      | harness-pinned  | `tests/harness-pinned.spec.ts` and `tests/egress.spec.ts`. CI-portable. |
| `e2e-fork` | fork (optional) | `tests/fork.spec.ts` against a harness built from `ANON_RPC_REPO`       |
| `live`     | live (by hand)  | `tests/live.spec.ts` against a real WalletShield over a real mixnet     |

```sh
nx run anon-rpc-e2e:e2e
ANON_RPC_REPO=/path/to/anon-rpc nx run anon-rpc-e2e:e2e-fork
WALLETSHIELD_URL=http://127.0.0.1:7070 nx run anon-rpc-e2e:live
```

Requirements: Foundry's `anvil` and `forge` (see the specifier README) and Playwright's Chromium
(`node_modules/.bin/playwright install chromium` once per machine; CI needs the same step).
`E2E_CHROMIUM=/path/to/chromium` runs the fork tier on another Chromium build.

### Harness-pinned

The page bundles `@anon-rpc/browser-harness` at an **exact** version (`0.3.3`, the latest
published) and is served from `http://127.0.0.1`. Loopback pages are not gated by Local Network
Access, so the published harness, which delegates nothing to its frame, reaches a loopback
WalletShield. The spec asserts:

- the page runs exactly the pinned package (the esbuild metafile names its files);
- the real bundle boots by specifier, in a `sandbox="allow-scripts"` frame;
- per chain (mainnet, Sepolia), the demo's public provider URL reaches WalletShield as
  `POST /_/url` with the URL in `ZKNet-URL`, and WalletShield's own URL for the network key
  (`<walletshield>/ethereum`, `/ethereum/sepolia`) as `POST /<network>`;
- the worker refuses a plain-http provider, a local URL that is not the configured WalletShield,
  a WalletShield path outside the network keys, and GET, before WalletShield sees anything;
- an upstream 429 reaches the host as a 429 with `retry-after`;
- every `ZKNet-Error` reason reaches the host as its `code` and `name`, at WalletShield's
  status for it, and an unknown reason as `UnexpectedReply`;
- with nothing listening, a call fails as `PeerUnreachable`, while the worker still becomes ready;
- a resolver serving other bytes is refused before anything runs;
- the worker's logs arrive at the host, without addresses, URLs or bodies.

### Egress control

The worker must reach the network only through its WalletShield. A guarded browser context
records every request in two layers (`src/egress-proxy.ts`):

- **the proxy**: everything except the exact allowed origins goes through a recording forward
  proxy, with `<-loopback>` so no other loopback port and no `localhost` alias is exempt. Loopback
  targets are forwarded; anything else is refused without a DNS lookup.
- **the browser layer**: Playwright's request events, which include the worker's fetches inside
  the sandboxed frame, cover the allowed origins that go direct.

Positive: the real worker, booted and called three times with a public provider URL, contacts only the bed (page, specifier
RPC, resolver) and, once ready, only WalletShield. Negative: `fixtures/leaky-worker.js`, a
hash-pinned worker that fetches another loopback port, a `localhost` alias of WalletShield's port
and a public host, and opens a WebSocket, is flagged on every count. A trap server confirms that
the fetch and the WebSocket handshake really left the sandbox.

**Proxied calls.** Chromium refuses a `fetch` that names a `targetAddressSpace` once it goes
through a proxy ("the resource is in address space `unknown`"). The transport names none, so a
browser that proxies the WalletShield address still reaches it; a test forces loopback through
the proxy to keep it that way. The egress check still lets the allowed origins go direct and
observes them on the browser layer.

### Fork

`WorkerInit.network.policy` (anon-rpc SPEC 0.4.1 §6.1, on the fork branch
`feat/worker-network-policy` until upstream merges it) is not in the published harness this
package pins (`0.3.3`, which only the `e2e` tier uses). With `ANON_RPC_REPO` set to an anon-rpc
checkout that has it — an absolute path, since Nx runs the tier from this package's directory —
this tier builds that checkout's `impl/harness-core` and `impl/browser-harness` (`npm run build`;
run `npm ci` in its `impl/` first) and bundles the page against them. Without the variable, only a
check runs that nothing in this package depends on a checkout.

The page is served over `https://127.0.0.1` with a throwaway self-signed certificate. Two
**controls** stand in for a real deployment:

- `--ip-address-space-overrides=127.0.0.1:<port>=public` makes the page a public one, so Local
  Network Access applies;
- the user's grants (`loopback_network`, `local_network`) are seeded as persisted site settings in
  a fresh profile, as the settings UI stores them. A CDP permission override would bypass frame
  delegation, which is what is under test.

Asserted:

- without a grant, the page is refused (the first control works);
- `allow: ["loopback"]` reaches a loopback WalletShield;
- no policy is blocked;
- `allow: ["loopback", "local"]` reaches a WalletShield on this host's RFC 1918 address;
- `allow: ["loopback"]` does not reach it.

The last two skip on a host without an RFC 1918 IPv4 address.

## See it yourself: the anon-rpc demo site

The EF demo site boots any worker by its specifier. `nx run anon-rpc-specifier:demo-up`
gives it one on this machine; `demo-down` stops it.

What `demo-up` does:

- builds the worker;
- starts anvil on `127.0.0.1:8545` and the keccak resolver on `127.0.0.1:8546`;
- deploys a `WorkerSpecifier` pinning the bundle, or moves it with `setWorker` when the bundle
  changed;
- reads it back and fetches the bundle the way a harness does;
- prints what to type into the demo.

It is idempotent. The specifier is deployed from anvil's account #9, so on a fresh anvil it is
always `0x700b6A60ce7EaaEA56F065753d8dcB9653dbAD35`; that address is what the `zknet-local`
preset below names. `DEMO_WALLETSHIELD` changes the printed worker config.

| Demo field    | Value                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker        | "ZKNet (local anvil)" on the `zknet/local-dev` site, or "Custom" with the address below                                                                                                     |
| Specifier     | `0x700b6A60ce7EaaEA56F065753d8dcB9653dbAD35`                                                                                                                                                |
| Bootstrap     | `http://127.0.0.1:8545` (chain 31337)                                                                                                                                                       |
| Worker RPC    | the prefilled public provider (e.g. `https://ethereum-rpc.publicnode.com`), fetched by the exit; or `http://127.0.0.1:7070/ethereum` (`/ethereum/sepolia`) for the exit operator's provider |
| Worker config | `{"walletshield":"http://127.0.0.1:7070"}`                                                                                                                                                  |

The site comes from the anon-rpc fork's dev-only branch `zknet/local-dev`. It adds chain 31337
and the `zknet-local` preset, which also carries `network.policy`. Build and serve it locally:

```sh
cd anon-rpc/impl && npm ci && npm run build && cd site && npx vite preview --host localhost --port 4173
# open http://localhost:4173/demo/?worker=zknet-local
```

A page on `http://localhost` is not gated by Local Network Access, so it needs no prompt.

The same build deployed to a public `https:` origin, e.g. Cloudflare Pages, works too:

- build command `cd impl && npm ci && npm run build`, output `impl/site/dist`;
- the browser then asks for local network access on the first request to `127.0.0.1`: allow it;
- if the bootstrap field is still empty afterwards (its prefill was refused before you answered),
  reload the page.

anvil and the resolver answer any origin's CORS.

The browser must reach this machine's `127.0.0.1:8545`, `127.0.0.1:8546` and WalletShield. If it
runs elsewhere (for example, this shell is in a container), forward those ports so they appear on
the browser's own `127.0.0.1`: the specifier records the resolver URL as `http://127.0.0.1:8546/…`.

The "Local file" drop is no substitute. A dropped file is read only after the drop, so a drag from
a source the browser cannot read at that path fails, upstream with an unhandled `NotFoundError`.
The fix is on the fork's `fix/demo-local-file`.

## Live tier

For a human with a running ZKNet dev mixnet. Nothing here starts one.

1. Start the mixnet and a WalletShield as usual (root README, _Run the local mixnet_ and _Run the
   clients locally_), and note WalletShield's `-listen` address. `docker/Makefile` rebuilds
   `rpc_proxy.alpine` and `walletshield.alpine` when their Go sources change; a running mix
   picks the new exit up only after `mixnet:stop` and `mixnet:start`.
2. Run:

   ```sh
   WALLETSHIELD_URL=http://127.0.0.1:7070 nx run anon-rpc-e2e:live
   ```

   `LIVE_TIMEOUT_MS` is the worker's per-call deadline (default 60000), `LIVE_RTT_PROBES` the
   number of timed exit probes (default 20). Add `-- --headed` to watch the browser.

3. It checks `/_/health` first, then boots the real bundle (local anvil for the specifier only)
   and prints each result:
   - **mix round-trip time**: min, p50, p90 and max over the exit probes;
   - **the upstream-timeout tripwire**: an exit probe delayed 3 s, just under the exit's 3.5 s
     upstream timeout (`rpc_proxy/limits.go`), must still come back. The katzenpost client drops
     a reply later than its encoded round trip plus 4.5 s (3 layers), so this fails if the
     timeout outgrows that window;
   - **per chain**, `eth_chainId` through the demo's public provider URL and through
     WalletShield's network URL: both must be `0x1` (mainnet) or `0xaa36a7` (Sepolia);
   - **private provider addresses**: the literals `https://10.0.0.1/` and
     `https://127.0.0.1:8545/` are refused by the worker (`UnsupportedRequest`); a public name
     that resolves to loopback (`localtest.me`) reaches the exit and fails there, after DNS, as
     `ExitRefused`.

   With `LIVE_EXIT_BED=/tmp/katzenpost.opt/docker/mixnet-alpine` (the dev mix's net directory)
   it also starts an https stub on the compose network's gateway, sets the exit's test-bed
   `[UserURLs] AllowCIDRs` and `RootCAs` to allow exactly that stub, restarts the service node,
   and names the stub in the exit container's `/etc/hosts` (`stub.exit-testbed.test`; the worker
   refuses private literals, and resolvers commonly drop wildcard-DNS private answers). It
   checks: the stub answers; `rfc1918.exit-testbed.test`, which resolves to `10.0.0.1`, is
   `ExitRefused` after DNS; a reply after 3 s is relayed; a hung reply fails as
   `UpstreamUnreachable` well inside WalletShield's 20 s (the exit's timeout, not a mix
   timeout); a 2 MiB reply is `TooLarge`; a 307 to a private address is relayed as 307 and
   never followed. It restores the packaged config and restarts the
   service node again afterwards. Use it only on a disposable dev mix.

On failure, the error name says where it broke: `PeerUnreachable`, `MixTimeout`, `ExitRefused`,
`ExitBusy`, `UpstreamUnreachable`, `BadReply`, or `UnexpectedReply`.

## Layout

```
page/main.ts, page/api.ts   the host page and its window.e2e API
src/chain.ts                anvil, keccak resolver and specifier deploys (specifier project CLIs)
src/page.ts                 page bundle (esbuild, harness alias) and http/https server
src/egress-proxy.ts         the egress check's proxy and violation filter
src/fork.ts                 fork harness build, TLS, public profile with seeded grants, LAN stub
src/exit-testbed.ts         the live tier's https stub and exit test-bed config
fixtures/leaky-worker.js    the egress check's negative control
tests/*.spec.ts             one file per tier
```

Runtime files land in `.run/` (gitignored).
