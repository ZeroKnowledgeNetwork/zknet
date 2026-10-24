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
`network_fetch` returns. The picker shows the live networks of `<urlNetwork>/networks.json`
and, muted, those cached on this device but no longer listed; an id can still be typed.

Each WalletShield argv shape has its own shell scope name (`src/utils/walletshield.ts`).
The shell plugin runs the first scope with a matching name and builds argv from that
scope's template, so a shared name silently drops extra arguments.
`walletshield.spec.ts` checks this against the capability files.
