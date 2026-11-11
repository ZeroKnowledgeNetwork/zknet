import { invoke } from "@tauri-apps/api/core";

// WalletShield's spawn, built in Rust (zknet_client_core::walletshield): the shell
// capability scope to spawn it under and its arguments, at the configured log level.
export type WalletshieldSpawn = { scope: string; args: string[] };

export const walletshieldSpawn = (listenAddress: string): Promise<WalletshieldSpawn> =>
  invoke<WalletshieldSpawn>("walletshield_spawn", { listenAddress });
