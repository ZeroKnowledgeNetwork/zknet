# ZKN UI Client

```sh
pnpm nx run @zknet/client:desktop-dev         # against the configured remote networks
pnpm nx run @zknet/client:desktop-dev-local   # against the local mixnet; connect to `dev-local`
```

`desktop-dev-local` serves the local mixnet's assets (see `apps/network-assets`) and
runs `tauri dev --config src-tauri/tauri.dev-local.conf.json`. That overlay only exists in
this target. It points `urlNetwork` at the local server, sets `walletshieldThin`, runs
WalletShield at `DEBUG` (`walletshieldLogLevel`; packaged builds run `INFO`), and adds
a `dev-local` capability allowing the thin WalletShield spawn. Packaged builds contain
neither. In thin mode the client re-downloads the network's assets on every connect, so
a rebuilt binary is never shadowed by a cached copy.

## Networks

The network list and the asset download are Rust: `src-tauri/src/network.rs` exposes
`zknet_core::network` (shared with the CLI) as the `networks_list`, `network_fetch` and
`platform` commands, with download progress on a `Channel`. The webview therefore holds
no `http`, `upload` or `chmod` grant; it only spawns WalletShield from the directory
`network_fetch` returns. The _Mix Networks_ table lists every network with a status badge
(`zknet_core::network::Status`), live ones first, and fills in the newest live network; an
id can still be typed. The built-in network source is never shown: the caption names the
source only when `urlNetwork` is overridden.
