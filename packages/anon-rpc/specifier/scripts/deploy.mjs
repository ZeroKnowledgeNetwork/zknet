#!/usr/bin/env node
// Deploy a WorkerSpecifier pinning a bundle's keccak256, or confirm the one
// already recorded for this chain. Idempotent: re-running with the same
// bundle and resolvers is a no-op that prints the same address.
//
// Usage:
//   node scripts/deploy.mjs [--tier dev|test|prod] [--bundle <path>] [--rpc-url <url>] [--resolver <entry>]...
//                           [--from <addr>] [--account <name> | --keystore <path>] [--password-file <path>]
//                           [--deployments <dir>] [--update] [--fresh] [--dry-run] [--skip-resolver-check]
//   public tiers add:       [--broadcast] [--rehearse [--deployer <addr>] [--fork-port N]]
//                           [--address <addr>] [--config <file>] [--records <dir>] [--posted <dir>]
//                           [--preflight <dir>] [--rehearse-record <file>]
//
// Without --tier (how e2e and demo-up call it) every chain-facing value is an
// input, so a public testnet is configuration:
//   RPC_URL / --rpc-url        default http://127.0.0.1:8545 (local anvil)
//   RESOLVER_URLS / --resolver comma-separated / repeatable; default: the local
//                              resolver URL of the bundle
//   signer                     default: the chain's first unlocked account
//                              (anvil); --account/--keystore select a Foundry
//                              keystore instead, unlocked with --password-file.
//                              This script never reads or prints key material.
// and the record of what was deployed is <deployments>/<chainId>.json
// (default .state/deployments). With a record whose code still exists:
//   same hash and resolvers  -> nothing to do
//   different                -> refuses, unless --update (owner setWorker on
//                               the same address) or --fresh (new contract)
// Resolvers must serve the pinned bytes before anything is sent (a harness
// would reject them anyway), unless --skip-resolver-check.
//
// --tier dev is the same, refusing any chain but 31337. A public tier (test,
// prod) instead:
//   - takes the RPC URL, keystore name, signer address and resolver templates
//     from the untracked deploy.local.json, and refuses a chain other than its own;
//   - refuses a bundle its preflight has not proven at the current HEAD;
//   - is a dry run unless --broadcast. With --broadcast it signs with the
//     keystore through Foundry's own password prompt: one prompt per
//     transaction, answered on the terminal, never seen by this script;
//   - acts on a working record, .state/records/<tier>.json (untracked), or,
//     without one, on the posted deployments/<tier>.json; it writes only the
//     working record, after a broadcast passes read-back. Posting it (copying
//     it to deployments/ and committing) is the operator's step;
//   - --address <addr> targets an existing specifier instead of the record's:
//     it must hold the EF reference code and be owned by the configured
//     deployer, and the record that results is the working one;
//   --rehearse runs the whole deploy on a local anvil fork of the tier's chain,
//     impersonating the deployer: no key, nothing sent to the real chain. It
//     reports gas, read-back and boot-resolve, and writes its would-be record
//     to .state/rehearse/<tier>.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { digestFile } from "./lib/digest.mjs";
import { head } from "./lib/git.mjs";
import {
  DEFAULT_BUNDLE,
  DEFAULT_RESOLVER_PORT,
  DEFAULT_RPC_URL,
  DEPLOYMENTS_DIR,
  LOCAL_CONFIG,
  POSTED_RECORDS_DIR,
  PROJECT_DIR,
  PREFLIGHT_DIR,
  STATE_DIR,
  WORKING_RECORDS_DIR,
} from "./lib/paths.mjs";
import { CliError, Daemon, foundry, isMain, run, runMain, runSigning } from "./lib/proc.mjs";
import {
  createdRecord,
  findRecord,
  recordPath,
  updatedRecord,
  writeRecord,
} from "./lib/record.mjs";
import { keccak256Hex } from "./lib/keccak.mjs";
import { answers, chainId as getChainId, code, rpc } from "./lib/rpc.mjs";
import { checkResolver, readSpecifier, REFERENCE_CODEHASH, sameList } from "./lib/specifier.mjs";
import { assertChain, banner, expandResolvers, loadTierConfig, tierOf } from "./lib/tiers.mjs";
import { readProof } from "./preflight.mjs";
import { resolverUrl } from "./resolver.mjs";
import { verifySpecifier } from "./verify.mjs";

/**
 * @typedef {object} Deployment
 * @property {number} chainId
 * @property {string} address
 * @property {string} transactionHash  the creation transaction
 * @property {string} deployer
 * @property {string} workerHash
 * @property {string[]} resolvers
 * @property {string} bundle            file name the hash was taken from (informational)
 */

/** @param {string} dir @param {number} id @returns {Deployment | undefined} */
export function readDeployment(dir, id) {
  const file = join(dir, `${id}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

/** @param {string} dir @param {Deployment} record */
function writeDeployment(dir, record) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.chainId}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * @typedef {object} Outcome
 * @property {'noop' | 'dry-run' | 'created' | 'updated'} action
 * @property {string} [address]
 * @property {string} [tx]
 * @property {number} [block]
 * @property {bigint} [gasUsed]
 * @property {bigint} [cost]   gasUsed x effectiveGasPrice, in wei
 * @property {bigint} [gasPrice] effectiveGasPrice, in wei
 * @property {string} [owner]
 */

/**
 * The deploy itself, shared by every mode: check resolvers, compare with what
 * the known address pins, then create, update, or nothing; read back.
 * @param {object} o
 * @param {string} o.rpcUrl
 * @param {string} o.workerHash
 * @param {string[]} o.resolvers
 * @param {string[]} o.signer        Foundry signer flags
 * @param {string} o.deployer
 * @param {string | undefined} o.known address the record names, if any
 * @param {'deploy' | 'refuse'} o.onMissing what to do when the known address has no code
 * @param {boolean} o.update
 * @param {boolean} o.fresh
 * @param {boolean} o.dryRun
 * @param {boolean} o.skipResolverCheck
 * @param {(cmd: string, args: string[]) => Promise<string>} o.sign runs a signing Foundry command
 * @param {string} o.hint            how to re-run with --update/--fresh, for messages
 * @returns {Promise<Outcome>}
 */
export async function deploySpecifier(o) {
  if (!o.skipResolverCheck) {
    for (const r of o.resolvers) {
      const check = await checkResolver(r, o.workerHash);
      if (!check.ok)
        throw new CliError(
          `resolver ${r}: ${check.detail} (publish the bundle, or --skip-resolver-check)`,
        );
      console.log(`✓ resolver serves the pinned bytes: ${r}`);
    }
  }

  const known = o.fresh ? undefined : o.known;
  const current = known ? await readSpecifier(o.rpcUrl, known) : undefined;
  if (current && current.codehash !== REFERENCE_CODEHASH) {
    throw new CliError(
      `recorded address ${known} holds other code (codehash ${current.codehash}); use --fresh`,
    );
  }
  if (known && !current && o.onMissing === "refuse") {
    throw new CliError(
      `recorded address ${known} has no code on this chain; check the record, or --fresh`,
    );
  }

  if (
    known &&
    current &&
    current.workerHash === o.workerHash &&
    sameList(current.resolvers, o.resolvers)
  ) {
    console.log(`✓ already deployed and up to date: ${known}`);
    return { action: "noop", address: known, owner: current.owner };
  }

  if (known && current) {
    if (!o.update) {
      throw new CliError(
        `specifier ${known} pins ${current.workerHash} with ${current.resolvers.length} resolver(s); ` +
          `pass --update to setWorker on it, or --fresh to deploy a new one${o.hint}`,
      );
    }
    if (current.owner.toLowerCase() !== o.deployer.toLowerCase()) {
      throw new CliError(
        `specifier ${known} is owned by ${current.owner}, not the signer ${o.deployer}`,
      );
    }
    if (o.dryRun) {
      console.log(
        `dry run: would setWorker(${o.workerHash}, ${o.resolvers.length} resolver(s)) on ${known}`,
      );
      return { action: "dry-run", address: known };
    }
    console.log(`setWorker on ${known}…`);
    const out = await o.sign(foundry("cast"), [
      "send",
      "--json",
      "--rpc-url",
      o.rpcUrl,
      ...o.signer,
      known,
      "setWorker(bytes32,string[])",
      o.workerHash,
      JSON.stringify(o.resolvers),
    ]);
    const receipt = JSON.parse(out);
    if (receipt.status !== "0x1") throw new CliError(`setWorker reverted: ${out}`);
    await readBack(o.rpcUrl, known, o.workerHash, o.resolvers);
    return {
      action: "updated",
      address: known,
      ...(await receiptFacts(o.rpcUrl, receipt.transactionHash)),
    };
  }

  if (known && !current)
    console.log(
      `recorded specifier ${known} has no code on this chain (chain reset?); deploying anew`,
    );
  if (o.dryRun) {
    console.log(`dry run: would deploy a new WorkerSpecifier from ${o.deployer}`);
    return { action: "dry-run" };
  }
  console.log("deploying WorkerSpecifier…");
  const out = await o.sign(foundry("forge"), [
    "create",
    "src/WorkerSpecifier.sol:WorkerSpecifier",
    "--rpc-url",
    o.rpcUrl,
    ...o.signer,
    "--broadcast",
    "--json",
    "--constructor-args",
    o.workerHash,
    JSON.stringify(o.resolvers),
  ]);
  const created = JSON.parse(out.slice(out.indexOf("{")));
  await readBack(o.rpcUrl, created.deployedTo, o.workerHash, o.resolvers);
  return {
    action: "created",
    address: created.deployedTo,
    ...(await receiptFacts(o.rpcUrl, created.transactionHash)),
  };
}

/** @param {string} rpcUrl @param {string} address @param {string} workerHash @param {string[]} resolvers */
async function readBack(rpcUrl, address, workerHash, resolvers) {
  const after = await readSpecifier(rpcUrl, address);
  if (!after) throw new CliError(`no code at ${address} after the transaction`);
  if (after.codehash !== REFERENCE_CODEHASH)
    throw new CliError(`deployed code differs from the reference (codehash ${after.codehash})`);
  if (after.workerHash !== workerHash)
    throw new CliError(`read-back workerHash() ${after.workerHash}, expected ${workerHash}`);
  if (!sameList(after.resolvers, resolvers))
    throw new CliError(`read-back workerResolvers() ${JSON.stringify(after.resolvers)}`);
  console.log("✓ on-chain read-back matches");
}

/** @param {string} rpcUrl @param {string} tx */
async function receiptFacts(rpcUrl, tx) {
  const r = /** @type {any} */ (await rpc(rpcUrl, "eth_getTransactionReceipt", [tx]));
  const gasUsed = BigInt(r.gasUsed);
  const gasPrice = BigInt(r.effectiveGasPrice ?? 0);
  return { tx, block: Number(r.blockNumber), gasUsed, gasPrice, cost: gasUsed * gasPrice };
}

/** @param {bigint} wei */
export const eth = (wei) => {
  const s = wei.toString().padStart(19, "0");
  const frac = s.slice(-18).replace(/0+$/, "");
  return `${s.slice(0, -18)}${frac ? `.${frac}` : ""} ETH`;
};

/** @param {string[]} argv */
async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      tier: { type: "string" },
      bundle: {
        type: "string",
        default: process.env.WORKER_BUNDLE || DEFAULT_BUNDLE,
      },
      "rpc-url": { type: "string" },
      resolver: { type: "string", multiple: true, default: [] },
      from: { type: "string", default: process.env.ETH_FROM },
      account: { type: "string" },
      keystore: { type: "string" },
      "password-file": { type: "string" },
      deployments: { type: "string", default: DEPLOYMENTS_DIR },
      update: { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "skip-resolver-check": { type: "boolean", default: false },
      broadcast: { type: "boolean", default: false },
      rehearse: { type: "boolean", default: false },
      deployer: { type: "string" },
      "fork-port": { type: "string", default: "8549" },
      config: { type: "string", default: LOCAL_CONFIG },
      records: { type: "string", default: WORKING_RECORDS_DIR },
      posted: { type: "string", default: POSTED_RECORDS_DIR },
      address: { type: "string" },
      preflight: { type: "string", default: PREFLIGHT_DIR },
      "rehearse-record": { type: "string" },
    },
  });
  const bundle = /** @type {string} */ (values.bundle);
  if (!existsSync(bundle))
    throw new CliError(`bundle not found: ${bundle} (build the worker, or pass --bundle)`);
  if (values.update && values.fresh) throw new CliError("--update and --fresh are exclusive");
  const tier = values.tier === undefined ? undefined : tierOf(values.tier);
  if (tier) console.log(banner(tier));
  return tier?.public ? publicTier(tier, values) : localChain(tier, values);
}

/**
 * Without a tier, or --tier dev: the local loop, unchanged.
 * @param {import('./lib/tiers.mjs').Tier | undefined} tier
 * @param {Record<string, any>} values
 */
async function localChain(tier, values) {
  if (values.broadcast || values.rehearse || values.deployer || values.address)
    throw new CliError(
      "--broadcast, --rehearse, --deployer and --address belong to the public tiers",
    );
  const rpcUrl = values["rpc-url"] || process.env.RPC_URL || DEFAULT_RPC_URL;
  const bundle = values.bundle;
  const dir = values.deployments;
  const digest = await digestFile(bundle);
  const workerHash = digest.keccak256;
  const fromEnv = (process.env.RESOLVER_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  /** @type {string[]} */
  const given = values.resolver;
  const resolvers =
    given.length > 0
      ? given
      : fromEnv.length > 0
        ? fromEnv
        : [resolverUrl("127.0.0.1", DEFAULT_RESOLVER_PORT, workerHash)];

  // Signer: a keystore when named, else an unlocked account of the node.
  /** @type {string[]} */
  let signer;
  let deployer;
  if (values.account || values.keystore) {
    signer = values.account ? ["--account", values.account] : ["--keystore", values.keystore];
    if (values["password-file"]) signer.push("--password-file", values["password-file"]);
    deployer = await run(foundry("cast"), ["wallet", "address", ...signer]);
  } else {
    const accounts = /** @type {string[]} */ (await rpc(rpcUrl, "eth_accounts"));
    deployer = values.from ?? accounts[0];
    if (!deployer)
      throw new CliError(
        `${rpcUrl} has no unlocked account; name a keystore with --account or --keystore`,
      );
    signer = ["--unlocked", "--from", deployer];
  }

  const chainId = await getChainId(rpcUrl);
  if (tier) assertChain(tier, chainId);
  console.log(`chain ${chainId} at ${rpcUrl}`);
  console.log(`bundle ${bundle} (${digest.bytes} bytes)`);
  console.log(`workerHash ${workerHash}`);
  for (const r of resolvers) console.log(`resolver ${r}`);
  console.log(`signer ${deployer}`);

  const record = readDeployment(dir, chainId);
  const outcome = await deploySpecifier({
    rpcUrl,
    workerHash,
    resolvers,
    signer,
    deployer,
    known: record?.address,
    onMissing: "deploy",
    update: values.update,
    fresh: values.fresh,
    dryRun: values["dry-run"],
    skipResolverCheck: values["skip-resolver-check"],
    sign: run,
    hint: "",
  });
  if (outcome.action === "dry-run") return;
  if (outcome.action !== "noop") {
    writeDeployment(dir, {
      chainId,
      address: /** @type {string} */ (outcome.address),
      transactionHash:
        outcome.action === "updated"
          ? /** @type {Deployment} */ (record).transactionHash
          : /** @type {string} */ (outcome.tx),
      deployer,
      workerHash,
      resolvers,
      bundle: bundle.split("/").pop() ?? bundle,
    });
  }
  console.log(outcome.address);
}

/**
 * test and prod: config from deploy.local.json, gated on preflight, dry run
 * unless --broadcast, or a rehearsal on a fork.
 * @param {import('./lib/tiers.mjs').Tier} tier
 * @param {Record<string, any>} values
 */
async function publicTier(tier, values) {
  if (values.account || values.keystore || values["password-file"] || values.from)
    throw new CliError(
      `tier ${tier.name} signs as deploy.local.json says, with an interactive password prompt; drop --account/--keystore/--password-file/--from`,
    );
  if (values.broadcast && values.rehearse)
    throw new CliError("--broadcast and --rehearse are exclusive");
  if (values["rpc-url"])
    throw new CliError(`tier ${tier.name} takes its RPC URL from deploy.local.json`);
  if (values.broadcast && values.resolver.length > 0)
    throw new CliError(
      "--resolver overrides are for dry runs and rehearsals; a broadcast pins the configured resolvers",
    );
  if (values.broadcast && values["skip-resolver-check"])
    throw new CliError("a broadcast always checks its resolvers");
  if (values.deployer && !values.rehearse)
    throw new CliError("--deployer is a rehearsal stand-in only");

  const config = loadTierConfig(tier, values.config, { resolvers: values.resolver.length === 0 });
  const deployer = values.deployer ?? config.deployer;
  const bundle = values.bundle;
  const digest = await digestFile(bundle);
  const workerHash = digest.keccak256;
  const resolvers =
    values.resolver.length > 0 ? values.resolver : expandResolvers(config.resolvers, workerHash);

  // The gate: a public tier deploys only a bundle its preflight proved at this commit.
  const proof = readProof(tier.name, values.preflight);
  const gitCommit = head();
  if (!proof)
    throw new CliError(
      `no preflight for ${tier.name}: run nx run anon-rpc-specifier:deploy:${tier.name}`,
    );
  if (proof.workerHash !== workerHash)
    throw new CliError(
      `preflight ${tier.name} proved ${proof.workerHash}, but the bundle is ${workerHash}; re-run the gate`,
    );
  if (proof.gitCommit !== gitCommit)
    throw new CliError(
      `preflight ${tier.name} ran at ${proof.gitCommit.slice(0, 12)}, HEAD is ${gitCommit.slice(0, 12)}; re-run the gate`,
    );

  const chainId = await getChainId(config.rpcUrl);
  assertChain(tier, chainId);
  const file = recordPath(values.records, tier.name);
  const found = findRecord(tier.name, values.records, values.posted);
  /** @type {import('./lib/record.mjs').TierRecord | undefined} */
  let record;
  let target;
  if (values.address) {
    target = await checkTarget(config.rpcUrl, values.address, deployer);
    // The record still applies when it names the same contract.
    if (found.record?.address.toLowerCase() === target.toLowerCase()) record = found.record;
  } else {
    record = found.record;
    target = record?.address;
  }
  if (record && record.chainId !== tier.chainId)
    throw new CliError(`${found.file} is for chain ${record.chainId}, not ${tier.chainId}`);

  console.log(
    `bundle ${bundle} (${digest.bytes} bytes) from ${gitCommit.slice(0, 12)}${proof.dirty ? " (tree dirty)" : ""}`,
  );
  console.log(`workerHash ${workerHash}`);
  for (const r of resolvers) console.log(`resolver ${r}`);
  console.log(`signer ${deployer}${values.deployer ? " (rehearsal stand-in)" : ""}`);
  if (record)
    console.log(
      `record ${relative(PROJECT_DIR, found.file ?? "")}: ${record.address} pins ${record.workerHash}`,
    );
  else
    console.log(target ? `target ${target} (--address; no record for it yet)` : "record none yet");
  if (found.posted && !values.address)
    console.log(
      `note: the posted deployments/${tier.name}.json names ${found.posted.address}; the working record wins (pass --address to choose)`,
    );

  const bundleRef = {
    file: bundle.split("/").pop() ?? bundle,
    bytes: digest.bytes,
    gitCommit,
    dirty: proof.dirty,
  };
  const common = {
    workerHash,
    resolvers,
    deployer,
    known: target,
    onMissing: /** @type {const} */ ("refuse"),
    update: values.update,
    fresh: values.fresh,
    skipResolverCheck: values["skip-resolver-check"],
    // Carried into every re-run line printed, so it names the same contract.
    hint: values.address ? ` --address ${values.address}` : "",
  };

  if (values.rehearse) {
    return rehearse(
      tier,
      config.rpcUrl,
      Number(values["fork-port"]),
      common,
      record,
      bundleRef,
      bundle,
      values["rehearse-record"],
    );
  }

  const dryRun = !values.broadcast || values["dry-run"];
  const outcome = await deploySpecifier({
    ...common,
    rpcUrl: config.rpcUrl,
    signer: ["--account", config.account, "--from", deployer],
    dryRun,
    sign: runSigning,
    hint: ` (nx run anon-rpc-specifier:deploy:${tier.name} --update${common.hint})`,
  });
  if (outcome.action === "dry-run") {
    const flags = [
      "--broadcast",
      ...(values.update ? ["--update"] : []),
      ...(values.fresh ? ["--fresh"] : []),
      ...(values.address ? ["--address", values.address] : []),
    ];
    console.log(`\nnothing sent. To send it (one keystore password prompt per transaction):`);
    console.log(`  nx run anon-rpc-specifier:deploy:${tier.name} ${flags.join(" ")}`);
    return;
  }
  // A no-op writes nothing, unless a broadcast run adopts a contract (an --address,
  // or the posted record) as the working record. A dry run never writes.
  if (outcome.action === "noop" && (dryRun || (record === found.record && found.file === file)))
    return;
  writeRecord(file, nextRecord(tier, chainId, outcome, record, bundleRef, workerHash, deployer));
  console.log(`✓ wrote the working record ${relative(PROJECT_DIR, file)}`);
  console.log(
    `  to post it: cp ${relative(PROJECT_DIR, file)} deployments/${tier.name}.json, review, git add, commit`,
  );
  console.log(outcome.address);
}

/**
 * The record after a create or an update. Only top-level fields of the
 * previous record are relied on; its `updates` may be missing or curated.
 * @param {import('./lib/tiers.mjs').Tier} tier
 * @param {number} chainId
 * @param {Outcome} outcome
 * @param {import('./lib/record.mjs').TierRecord | undefined} record
 * @param {import('./lib/record.mjs').BundleRef} bundle
 * @param {string} workerHash
 * @param {string} owner
 */
export function nextRecord(tier, chainId, outcome, record, bundle, workerHash, owner) {
  const tx = /** @type {string} */ (outcome.tx);
  const block = /** @type {number} */ (outcome.block);
  const address = /** @type {string} */ (outcome.address);
  if (outcome.action === "created")
    return createdRecord({
      tier: tier.name,
      chainId,
      address,
      codehash: REFERENCE_CODEHASH,
      owner,
      creation: { tx, block },
      workerHash,
      bundle,
    });
  // An --address with no record starts one from what the chain showed; it has no creation.
  /** @type {import('./lib/record.mjs').TierRecord} */
  const base = record ?? {
    tier: tier.name,
    chainId,
    address,
    contract: "WorkerSpecifier",
    codehash: REFERENCE_CODEHASH,
    owner,
    workerHash,
    bundle,
    updates: [],
  };
  if (outcome.action !== "updated") return { ...base, owner, workerHash, bundle };
  return updatedRecord(base, { tx, block, workerHash, bundle, owner });
}

/**
 * An --address must be a specifier this deployer can update: the EF reference
 * code, owned by the configured deployer.
 * @param {string} rpcUrl
 * @param {string} address
 * @param {string} deployer
 * @returns {Promise<string>} the address
 */
async function checkTarget(rpcUrl, address, deployer) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address))
    throw new CliError(`--address ${address} is not an address`);
  // Code first: a contract that is not a specifier cannot answer workerHash().
  const runtime = await code(rpcUrl, address);
  if (runtime === "0x") throw new CliError(`--address ${address} holds no code on this chain`);
  const codehash = keccak256Hex(Buffer.from(runtime.slice(2), "hex"));
  if (codehash !== REFERENCE_CODEHASH)
    throw new CliError(
      `--address ${address} is not the EF reference WorkerSpecifier (codehash ${codehash})`,
    );
  const spec = /** @type {NonNullable<Awaited<ReturnType<typeof readSpecifier>>>} */ (
    await readSpecifier(rpcUrl, address)
  );
  if (spec.owner.toLowerCase() !== deployer.toLowerCase())
    throw new CliError(
      `--address ${address} is owned by ${spec.owner}, not the configured deployer ${deployer}`,
    );
  return address;
}

/**
 * The whole deploy on a local anvil fork of the tier's chain, as the deployer
 * (impersonated; no key), then a boot-resolve through the fork. The real chain
 * is only read, by anvil.
 * @param {import('./lib/tiers.mjs').Tier} tier
 * @param {string} upstream the tier's RPC URL
 * @param {number} port
 * @param {Omit<Parameters<typeof deploySpecifier>[0], 'rpcUrl' | 'signer' | 'dryRun' | 'sign'>} common
 * @param {import('./lib/record.mjs').TierRecord | undefined} record
 * @param {import('./lib/record.mjs').BundleRef} bundleRef
 * @param {string} bundle
 * @param {string} [out] where the would-be record goes (default .state/rehearse/<tier>.json)
 */
async function rehearse(tier, upstream, port, common, record, bundleRef, bundle, out) {
  const realBalance = BigInt(
    /** @type {string} */ (await rpc(upstream, "eth_getBalance", [common.deployer, "latest"])),
  );
  console.log(`deployer balance on ${tier.network}: ${eth(realBalance)}`);

  const forkUrl = `http://127.0.0.1:${port}`;
  const fork = new Daemon("anvil fork", join(STATE_DIR, `fork-${port}.pid`), () =>
    answers(forkUrl),
  );
  // --quiet: anvil's banner would print the upstream URL, which may carry an API key.
  await fork.start(
    foundry("anvil"),
    [
      "--quiet",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--fork-url",
      upstream,
      "--auto-impersonate",
    ],
    60_000,
  );
  try {
    const forkChain = await getChainId(forkUrl);
    assertChain(tier, forkChain);
    console.log(
      `rehearsing on a fork of chain ${forkChain} at ${forkUrl} (nothing reaches ${tier.network})`,
    );
    // Fund the impersonated deployer on the fork only, so the rehearsal runs
    // to the end; whether the real balance suffices is reported below.
    await rpc(forkUrl, "anvil_setBalance", [common.deployer, "0x8ac7230489e80000"]);

    const outcome = await deploySpecifier({
      ...common,
      rpcUrl: forkUrl,
      signer: ["--unlocked", "--from", common.deployer],
      dryRun: false,
      sign: run,
      hint: ` (nx run anon-rpc-specifier:deploy:${tier.name} --rehearse --update${common.hint})`,
    });
    if (outcome.action !== "noop") {
      const cost = /** @type {bigint} */ (outcome.cost);
      console.log(
        `rehearsal: ${outcome.action} ${outcome.address} — gasUsed ${outcome.gasUsed}, cost ${eth(cost)} at the fork's ${Number(outcome.gasPrice) / 1e9} gwei; at 10 gwei it would be ${eth(/** @type {bigint} */ (outcome.gasUsed) * 10_000_000_000n)}`,
      );
      console.log(
        realBalance >= cost
          ? `✓ the deployer's real balance covers it (${eth(realBalance)})`
          : `✗ the deployer's real balance (${eth(realBalance)}) does not cover it: fund it first`,
      );
    }
    console.log("\nboot-resolve through the fork:");
    const failures = await verifySpecifier(
      forkUrl,
      /** @type {string} */ (outcome.address),
      bundle,
    );
    if (failures > 0) throw new CliError(`rehearsal boot-resolve failed (${failures})`);

    if (outcome.action !== "noop") {
      const file = out ?? join(STATE_DIR, "rehearse", `${tier.name}.json`);
      writeRecord(
        file,
        nextRecord(
          tier,
          tier.chainId,
          outcome,
          record,
          bundleRef,
          common.workerHash,
          common.deployer,
        ),
      );
      console.log(`would-be record: ${file}`);
    }
    console.log(`✓ rehearsal of deploy:${tier.name} passed`);
  } finally {
    await fork.stop();
  }
}

if (isMain(import.meta.url)) runMain(main);
