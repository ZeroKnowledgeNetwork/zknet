// Deployment tiers and the inputs a public tier deploys with.
//
// A tier fixes which chain a deploy may reach; that mapping lives here, in
// code, so no input can redefine what `test` means. Everything else
// chain-facing for a public tier (RPC URL, signer address, keystore name,
// resolver URLs) is an input, as a flag or from the environment: the tools
// hold no deployment's values. Resolver URLs become public on-chain at deploy.

import { contentPath } from "./digest.mjs";
import { CliError } from "./proc.mjs";

/**
 * @typedef {object} Tier
 * @property {'dev' | 'test' | 'prod'} name
 * @property {number} chainId   the only chain this tier may send to
 * @property {string} network   human name of that chain
 * @property {boolean} public   public tiers sign with a keystore, dry-run by default, and keep a committed record
 */

/** @type {Record<string, Tier>} */
export const TIERS = {
  dev: { name: "dev", chainId: 31337, network: "local anvil", public: false },
  test: {
    name: "test",
    chainId: 11155111,
    network: "Ethereum Sepolia",
    public: true,
  },
  prod: { name: "prod", chainId: 1, network: "Ethereum mainnet", public: true },
};

/** @param {string | undefined} name @returns {Tier} */
export function tierOf(name) {
  const tier = name === undefined ? undefined : TIERS[name];
  if (tier === undefined)
    throw new CliError(`unknown tier ${name}; expected one of ${Object.keys(TIERS).join(", ")}`);
  return tier;
}

/** @param {Tier} tier */
export function banner(tier) {
  return `tier=${tier.name} chainId=${tier.chainId} (${tier.network})`;
}

/**
 * Refuse to act on a chain other than the tier's: a wrong RPC URL must not
 * send to another chain.
 * @param {Tier} tier
 * @param {number} chainId what the RPC endpoint reports
 */
export function assertChain(tier, chainId) {
  if (chainId !== tier.chainId)
    throw new CliError(
      `RPC endpoint is chain ${chainId}, but tier ${tier.name} is chain ${tier.chainId} (${tier.network}); refusing`,
    );
}

/**
 * @typedef {object} PublicInputs
 * @property {string} rpcUrl
 * @property {string} deployer    the address the keystore signs as, or a rehearsal stand-in
 * @property {string} [account]   Foundry keystore name, resolved in Foundry's default keystore directory
 * @property {string[]} resolvers entries or templates; `{path}` becomes <hash[0:2]>/<hash[2:]>
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A comma-separated environment list (`RESOLVER_URLS`), trimmed, empty entries dropped. */
export const envList = (/** @type {string | undefined} */ v) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Check one public tier's inputs. Values are never printed by this module, and
 * an unfilled template value (one still holding `<`) counts as missing.
 * @param {Tier} tier
 * @param {{ rpcUrl?: string, deployer?: string, account?: string, resolvers: string[] }} given
 * @param {{ broadcast?: boolean }} [opts] a broadcast also needs the keystore, and pins only `https:` entries
 * @returns {PublicInputs}
 */
export function publicInputs(tier, given, { broadcast = false } = {}) {
  /** @param {string | undefined} v @param {string} what */
  const need = (v, what) => {
    if (typeof v !== "string" || v === "" || v.includes("<"))
      throw new CliError(`tier ${tier.name} needs ${what}`);
    return v;
  };
  const rpcUrl = need(given.rpcUrl, "--rpc-url (or RPC_URL)");
  const deployer = need(given.deployer, "--from (or ETH_FROM): the address its keystore signs as");
  if (!ADDRESS.test(deployer)) throw new CliError(`tier ${tier.name}: --from is not an address`);
  const account = broadcast
    ? need(given.account, "--account (or ETH_KEYSTORE_ACCOUNT): the Foundry keystore to sign with")
    : given.account;
  if (given.resolvers.length === 0)
    throw new CliError(`tier ${tier.name} needs --resolver (or RESOLVER_URLS), at least one`);
  for (const r of given.resolvers) {
    if (r.includes("<"))
      throw new CliError(`tier ${tier.name}: a resolver still holds a placeholder`);
    if (broadcast && !r.startsWith("https://"))
      throw new CliError(`tier ${tier.name}: a broadcast pins https: resolvers only`);
  }
  return { rpcUrl, deployer, ...(account ? { account } : {}), resolvers: given.resolvers };
}

/**
 * The resolver list a specifier pins for one bundle.
 * @param {string[]} templates
 * @param {string} workerHash 0x keccak256
 */
export function expandResolvers(templates, workerHash) {
  const path = contentPath(workerHash);
  return templates.map((t) => t.replaceAll("{path}", path));
}
