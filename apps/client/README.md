# ZKN UI Client

```sh
pnpm nx run client:desktop-dev         # against the configured remote networks
pnpm nx run client:desktop-dev-local   # against the local mixnet; connect to `dev-local`
```

`desktop-dev-local` serves the local mixnet's assets (see `apps/network-assets`) and
runs `tauri dev --config src-tauri/tauri.dev-local.conf.json`. That overlay only exists in
this target. It points `urlNetwork` at the local server and runs WalletShield at `DEBUG`
(`walletshieldLogLevel`; packaged builds run `INFO`); it grants nothing extra. WalletShield
picks full or thin mode from the network's config, so `dev-local`'s thin config runs from
any launch. Re-staging gives a network a new `created`, so a rebuilt binary is downloaded
again rather than shadowed by a cached copy.

## Networks

The network list and the asset download are Rust: `src-tauri/src/network.rs` exposes
`zknet_core::network` (shared with the CLI) as the `networks_list`, `network_fetch` and
`platform` commands, with download progress on a `Channel`. The webview therefore holds
no `http`, `upload` or `chmod` grant; it only spawns WalletShield from the directory
`network_fetch` returns. The _Mix Networks_ table lists every network the client knows,
each at its own source, with a status badge (`zknet_core::network::Status`), published ones
first, and fills in the newest one; an id can still be typed. Every listed network connects,
whatever `urlNetwork` the app was started with. The built-in network source is never shown:
the caption names the launch source only when `urlNetwork` is overridden, and a Source
column appears only once a network from another source is known.
