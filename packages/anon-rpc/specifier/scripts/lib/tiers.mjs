// Deployment tiers and their local configuration.
//
// A tier fixes which chain a deploy may reach; that mapping lives here, in
// code, so a config file cannot redefine what `test` means. Everything else
// chain-facing for a public tier (RPC URL, keystore name, signer address,
// resolver URLs, Pages project) comes from the untracked deploy.local.json,
// which is never committed: resolver URLs become public on-chain at deploy
// time, but they are kept out of the code.

import { existsSync, readFileSync } from "node:fs";
import { contentPath } from "./digest.mjs";
import { LOCAL_CONFIG } from "./paths.mjs";
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
 * @typedef {object} TierConfig
 * @property {string} rpcUrl
 * @property {string} account      Foundry keystore name, resolved in Foundry's default keystore directory
 * @property {string} deployer     the address that keystore signs as
 * @property {string[]} resolvers  URL templates; `{path}` becomes <hash[0:2]>/<hash[2:]>
 * @property {{ project: string }} [pages]
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Read one tier's section of the local config, checking its shape. Values are
 * never printed by this module.
 * @param {Tier} tier
 * @param {string} [file]
 * @param {{ resolvers?: boolean }} [need] resolvers: false when the caller supplies its own
 *   (a dry run or rehearsal with --resolver), so the configured list may still be a placeholder
 * @returns {TierConfig}
 */
export function loadTierConfig(
  tier,
  file = LOCAL_CONFIG,
  { resolvers: needResolvers = true } = {},
) {
  if (!existsSync(file))
    throw new CliError(
      `${file} not found: copy deploy.local.example.json to deploy.local.json and fill in the ${tier.name} section`,
    );
  let all;
  try {
    all = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError(`${file}: ${error instanceof Error ? error.message : error}`);
  }
  const section = all?.[tier.name];
  if (section === undefined || section === null || typeof section !== "object")
    throw new CliError(`${file} has no "${tier.name}" section`);
  /** @param {string} key */
  const need = (key) => {
    const v = section[key];
    if (typeof v !== "string" || v === "" || v.includes("<"))
      throw new CliError(`${file}: ${tier.name}.${key} is not set`);
    return v;
  };
  const rpcUrl = need("rpcUrl");
  const account = need("account");
  const deployer = need("deployer");
  if (!ADDRESS.test(deployer))
    throw new CliError(`${file}: ${tier.name}.deployer is not an address`);
  const resolvers = needResolvers ? section.resolvers : [];
  if (needResolvers && (!Array.isArray(resolvers) || resolvers.length === 0))
    throw new CliError(`${file}: ${tier.name}.resolvers must be a non-empty list`);
  for (const r of resolvers) {
    if (typeof r === "string" && r.includes("<"))
      throw new CliError(`${file}: ${tier.name}.resolvers still holds a placeholder`);
    if (typeof r !== "string" || !r.includes("{path}"))
      throw new CliError(`${file}: every ${tier.name}.resolvers entry must contain {path}`);
    if (!r.startsWith("https://"))
      throw new CliError(`${file}: ${tier.name}.resolvers entries must be https: URLs`);
  }
  const project = section.pages?.project;
  return {
    rpcUrl,
    account,
    deployer,
    resolvers,
    ...(typeof project === "string" && project !== "" ? { pages: { project } } : {}),
  };
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
