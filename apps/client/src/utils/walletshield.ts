// The shell plugin resolves a spawn by the first capability scope whose name
// matches, then builds argv from that scope's argument template: arguments
// beyond the template are dropped silently. The argv here must match the
// `walletshield-listen` scope in the capabilities. WalletShield picks its mode
// (full or thin) from the network's config, so no argument chooses it.
export const WALLETSHIELD_SCOPE = "walletshield-listen";

export const walletshieldSpawn = (listenAddress: string, logLevel: string) => ({
  scope: WALLETSHIELD_SCOPE,
  args: ["-listen", listenAddress, "-config", "client.toml", "-log_level", logLevel],
});
