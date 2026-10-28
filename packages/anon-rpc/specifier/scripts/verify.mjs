#!/usr/bin/env node
// Boot-resolve a deployed specifier the way a harness does: read
// workerHash() / workerResolvers() through cast, fetch every http(s)
// resolver, and require keccak256(body) == workerHash. With --bundle, also
// require the pinned hash to be that file's.
//
// Usage:
//   node scripts/verify.mjs [--tier dev|test|prod] [--address <addr>] [--rpc-url <url>]
//                           [--bundle <path>] [--deployments <dir>] [--config <file>] [--records <dir>] [--posted <dir>]
//
// Without --address, the address comes from the record: <deployments>/<chainId>.json
// locally, for a public tier the working record .state/records/<tier>.json, else the
// posted deployments/<tier>.json (its RPC URL comes from deploy.local.json). A tier refuses an endpoint on another chain.
// Exits 1 unless at least one resolver admits the bundle and none serves
// other bytes.

import { parseArgs } from "node:util";
import { digestFile } from "./lib/digest.mjs";
import {
  DEFAULT_RPC_URL,
  DEPLOYMENTS_DIR,
  LOCAL_CONFIG,
  POSTED_RECORDS_DIR,
  WORKING_RECORDS_DIR,
} from "./lib/paths.mjs";
import { CliError, isMain, runMain } from "./lib/proc.mjs";
import { findRecord } from "./lib/record.mjs";
import { chainId } from "./lib/rpc.mjs";
import { checkResolver, readSpecifier, REFERENCE_CODEHASH } from "./lib/specifier.mjs";
import { assertChain, banner, loadTierConfig, tierOf } from "./lib/tiers.mjs";
import { readDeployment } from "./deploy.mjs";

/**
 * Print what the specifier pins and whether its resolvers admit it.
 * @param {string} rpcUrl
 * @param {string} address
 * @param {string} [bundle] also require the pinned hash to be this file's
 * @returns {Promise<number>} the number of failures
 */
export async function verifySpecifier(rpcUrl, address, bundle) {
  const spec = await readSpecifier(rpcUrl, address);
  if (!spec) throw new CliError(`no code at ${address}`);
  console.log(`specifier ${address}`);
  console.log(
    `  codehash        ${spec.codehash}${spec.codehash === REFERENCE_CODEHASH ? "  (EF reference WorkerSpecifier)" : "  (NOT the reference)"}`,
  );
  console.log(`  owner           ${spec.owner}`);
  console.log(`  workerHash()    ${spec.workerHash}`);
  spec.resolvers.forEach((r, i) => console.log(`  workerResolvers()[${i}] ${r}`));

  let failures = 0;
  if (spec.codehash !== REFERENCE_CODEHASH) failures++;
  if (bundle) {
    const digest = await digestFile(bundle);
    const same = digest.keccak256 === spec.workerHash;
    console.log(`${same ? "✓" : "✗"} bundle ${bundle} hashes to ${digest.keccak256}`);
    if (!same) failures++;
  }

  let admitted = 0;
  for (const r of spec.resolvers) {
    const check = await checkResolver(r, spec.workerHash);
    const fetched = /^https?:\/\//.test(r);
    console.log(`${check.ok ? (fetched ? "✓" : "·") : "✗"} ${r}: ${check.detail}`);
    if (!check.ok) failures++;
    else if (fetched) admitted++;
  }
  if (admitted === 0) {
    console.log("✗ no resolver served bytes matching workerHash()");
    failures++;
  }
  return failures;
}

/** @param {string[]} argv */
async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      tier: { type: "string" },
      address: { type: "string" },
      "rpc-url": { type: "string" },
      bundle: { type: "string" },
      deployments: { type: "string", default: DEPLOYMENTS_DIR },
      config: { type: "string", default: LOCAL_CONFIG },
      records: { type: "string", default: WORKING_RECORDS_DIR },
      posted: { type: "string", default: POSTED_RECORDS_DIR },
    },
  });
  const tier = values.tier === undefined ? undefined : tierOf(values.tier);
  if (tier) console.log(banner(tier));

  let rpcUrl = values["rpc-url"] || process.env.RPC_URL || DEFAULT_RPC_URL;
  if (tier?.public && !values["rpc-url"])
    rpcUrl = loadTierConfig(tier, /** @type {string} */ (values.config), {
      resolvers: false,
    }).rpcUrl;
  const id = await chainId(rpcUrl);
  if (tier) assertChain(tier, id);

  const address =
    values.address ??
    (tier?.public
      ? findRecord(
          tier.name,
          /** @type {string} */ (values.records),
          /** @type {string} */ (values.posted),
        ).record?.address
      : readDeployment(/** @type {string} */ (values.deployments), id)?.address);
  if (!address) throw new CliError(`no --address and no recorded deployment for chain ${id}`);
  console.log(`chain ${id}`);
  const failures = await verifySpecifier(rpcUrl, address, values.bundle);
  return failures === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) runMain(main);
