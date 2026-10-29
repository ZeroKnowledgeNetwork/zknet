#!/usr/bin/env node
// The local backend for trying the worker in the anon-rpc demo site: anvil on
// 127.0.0.1:8545, the keccak resolver on 127.0.0.1:8546 serving the worker
// bundle, and a WorkerSpecifier pinning it. Prints what to type into the demo.
//
// Usage:
//   node scripts/demo.mjs up     idempotent; moves the specifier (setWorker) when the bundle changed
//   node scripts/demo.mjs down   stops anvil and the resolver
//
//   WORKER_BUNDLE      bundle to serve (default: the worker project's dist)
//   DEMO_WALLETSHIELD  WalletShield URL for the printed worker config and RPC URL (default http://127.0.0.1:7070)

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { digestFile } from "./lib/digest.mjs";
import { DEFAULT_BUNDLE, DEFAULT_RESOLVER_PORT, PROJECT_DIR, STATE_DIR } from "./lib/paths.mjs";
import { CliError, isMain, runMain } from "./lib/proc.mjs";

export const ANVIL_PORT = 8545;
export const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
export const CHAIN_ID = 31337;
/**
 * The demo deploys from anvil's default account #9, not account 0, so its
 * specifier has an address of its own: account 0's first contract
 * (0x5FbD…0aa3) is what every other local deploy gets, and a page that knows
 * one of them would mistake it for the other. The demo's `zknet-local` adopters
 * entry hardcodes the result. It holds while this is account #9's first
 * transaction on the chain; `--update` keeps the address afterwards.
 */
export const DEPLOYER = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720";
export const EXPECTED_ADDRESS = "0x700b6A60ce7EaaEA56F065753d8dcB9653dbAD35";

/** The demo's own deployment record, apart from the local loop's `deploy`. */
const DEPLOYMENTS = join(STATE_DIR, "demo-deployments");

/** Run one of this project's scripts, streaming its output. */
function script(name, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(PROJECT_DIR, "scripts", name), ...args], {
      cwd: PROJECT_DIR,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    p.stdout.on("data", (b) => {
      out += b;
      process.stdout.write(b);
    });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve(out) : reject(new CliError(`${name} ${args[0] ?? ""} exited ${code}`)),
    );
  });
}

async function up() {
  const bundle = process.env.WORKER_BUNDLE || DEFAULT_BUNDLE;
  const port = ["--port", String(DEFAULT_RESOLVER_PORT)];
  const resolver = (await script("resolver.mjs", ["put", "--bundle", bundle, ...port])).trim();
  await script("resolver.mjs", ["start", ...port]);
  await script("anvil.mjs", ["start", "--port", String(ANVIL_PORT)]);
  // --update: same bundle → no-op; new bundle → setWorker on the same address.
  await script("deploy.mjs", [
    "--from",
    DEPLOYER,
    "--bundle",
    bundle,
    "--rpc-url",
    RPC_URL,
    "--resolver",
    resolver,
    "--deployments",
    DEPLOYMENTS,
    "--update",
  ]);
  await script("verify.mjs", [
    "--rpc-url",
    RPC_URL,
    "--bundle",
    bundle,
    "--deployments",
    DEPLOYMENTS,
  ]);

  const record = JSON.parse(readFileSync(join(DEPLOYMENTS, `${CHAIN_ID}.json`), "utf8"));
  const digest = await digestFile(bundle);
  const config = { walletshield: process.env.DEMO_WALLETSHIELD || "http://127.0.0.1:7070" };
  const moved = record.address.toLowerCase() !== EXPECTED_ADDRESS.toLowerCase();
  console.log(`
ZKNet anon-rpc demo backend is up.

  Specifier address  ${record.address}${moved ? `\n                     ⚠ not ${EXPECTED_ADDRESS}: account #9 sent another transaction first on this anvil;\n                       run demo-down then demo-up for a fresh chain, or use "Custom" with this address` : '   (the "ZKNet (local anvil)" preset)'}
  Chain id           ${CHAIN_ID} (anvil)
  Bootstrap RPC      ${RPC_URL}
  Worker RPC         any public https provider URL, e.g. https://ethereum-rpc.publicnode.com
                     (the exit fetches it), or ${config.walletshield}/ethereum (or /ethereum/sepolia)
                     for the exit operator's provider
  Worker config      ${JSON.stringify(config)}
  Bundle keccak256   ${digest.keccak256}  (${digest.bytes} bytes)
  Resolver           ${resolver}

Stop it with: nx run anon-rpc-specifier:demo-down`);
}

async function down() {
  await script("anvil.mjs", ["stop", "--port", String(ANVIL_PORT)]);
  await script("resolver.mjs", ["stop", "--port", String(DEFAULT_RESOLVER_PORT)]);
}

/** @param {string[]} argv */
async function main(argv) {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true });
  if (positionals[0] === "up") return up();
  if (positionals[0] === "down") return down();
  throw new CliError("usage: demo.mjs up|down");
}

if (isMain(import.meta.url)) runMain(main);
