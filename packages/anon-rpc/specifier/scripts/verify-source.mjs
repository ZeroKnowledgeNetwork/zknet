#!/usr/bin/env node
// Verify a public tier's specifier source on Sourcify (no API key):
// `forge verify-contract --verifier sourcify`, constructor arguments recovered
// from the creation transaction, so it works after any number of setWorker
// calls. This is the explorer's check that the code is the published source;
// `verify` is the harness's check that the bundle resolves.
//
// Usage:
//   node scripts/verify-source.mjs --tier test|prod [--address <addr>] [--config <file>] [--records <dir>] [--posted <dir>] [--dry-run]

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  LOCAL_CONFIG,
  POSTED_RECORDS_DIR,
  PROJECT_DIR,
  WORKING_RECORDS_DIR,
} from "./lib/paths.mjs";
import { CliError, foundry, isMain, runMain } from "./lib/proc.mjs";
import { findRecord } from "./lib/record.mjs";
import { chainId } from "./lib/rpc.mjs";
import { assertChain, banner, loadTierConfig, tierOf } from "./lib/tiers.mjs";

/**
 * @param {string} address
 * @param {number} chain
 * @param {string} rpcUrl
 */
export const verifyArgs = (address, chain, rpcUrl) => [
  "verify-contract",
  address,
  "src/WorkerSpecifier.sol:WorkerSpecifier",
  "--verifier",
  "sourcify",
  "--chain",
  String(chain),
  "--rpc-url",
  rpcUrl,
  "--guess-constructor-args",
  "--watch",
];

/** @param {string[]} argv */
async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      tier: { type: "string" },
      address: { type: "string" },
      config: { type: "string", default: LOCAL_CONFIG },
      records: { type: "string", default: WORKING_RECORDS_DIR },
      posted: { type: "string", default: POSTED_RECORDS_DIR },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const tier = tierOf(values.tier);
  if (!tier.public) throw new CliError("verify-source is for the public tiers (test, prod)");
  console.log(banner(tier));
  const { rpcUrl } = loadTierConfig(tier, /** @type {string} */ (values.config), {
    resolvers: false,
  });
  assertChain(tier, await chainId(rpcUrl));
  const address =
    values.address ??
    findRecord(
      tier.name,
      /** @type {string} */ (values.records),
      /** @type {string} */ (values.posted),
    ).record?.address;
  if (!address) throw new CliError(`no --address and no working or posted record for ${tier.name}`);

  const args = verifyArgs(address, tier.chainId, rpcUrl);
  // The RPC URL may carry an API key: show the command without it.
  console.log(`forge ${args.map((a) => (a === rpcUrl ? "<rpcUrl>" : a)).join(" ")}`);
  if (values["dry-run"]) return;
  const r = spawnSync(foundry("forge"), args, {
    cwd: PROJECT_DIR,
    stdio: "inherit",
  });
  return r.status ?? 1;
}

if (isMain(import.meta.url)) runMain(main);
