#!/usr/bin/env node
// The tier-specific half of the deploy gate. The Nx `preflight` target runs
// the cached half first (compile, tests, lint, typecheck, the worker build)
// through its dependsOn; this script adds what a tier demands on top and
// records what it proved, so `deploy` can refuse a bundle no gate has seen.
//
// Usage:
//   node scripts/preflight.mjs --tier dev|test|prod [--bundle <path>] [--posted <dir>]
//
//   dev   nothing more: the cached graph is the whole gate
//   test  the bundle must equal a build from a clean export of HEAD, so the
//         pinned hash maps to a commit; records HEAD and whether the tree was dirty
//   prod  test, plus: an empty `git status --porcelain`, on `main`, HEAD on a
//         remote branch, and the posted deployments/test.json already pinning this bundle
//
// Writes .state/preflight/<tier>.json: { tier, workerHash, bytes, gitCommit, dirty, at }.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { digestFile } from "./lib/digest.mjs";
import { branch, head, porcelain, remotesContainingHead } from "./lib/git.mjs";
import { DEFAULT_BUNDLE, POSTED_RECORDS_DIR, PREFLIGHT_DIR } from "./lib/paths.mjs";
import { CliError, isMain, runMain } from "./lib/proc.mjs";
import { readRecord, recordPath } from "./lib/record.mjs";
import { banner, tierOf } from "./lib/tiers.mjs";
import { DEFAULT_BUILD, DEFAULT_INSTALL, reproduce } from "./reproducible.mjs";

/**
 * @typedef {object} Proof
 * @property {string} tier
 * @property {string} workerHash
 * @property {number} bytes
 * @property {string} gitCommit
 * @property {boolean} dirty
 * @property {string} at
 */

/**
 * What prod demands of the repository, as a list of reasons to refuse.
 * @param {{ porcelain: string, branch: string, remotes: string[], testWorkerHash?: string, workerHash: string }} s
 * @returns {string[]}
 */
export function prodRefusals(s) {
  const reasons = [];
  if (s.porcelain !== "") reasons.push("the working tree is not clean (git status --porcelain)");
  if (s.branch !== "main") reasons.push(`HEAD is on "${s.branch || "detached"}", not main`);
  if (s.remotes.length === 0) reasons.push("HEAD is on no remote branch (push it first)");
  if (s.testWorkerHash === undefined) reasons.push("deployments/test.json does not exist");
  else if (s.testWorkerHash !== s.workerHash)
    reasons.push(
      `deployments/test.json pins ${s.testWorkerHash}, not this bundle; prod follows test`,
    );
  return reasons;
}

/** @param {string} tier @param {string} [dir] */
export const proofPath = (tier, dir = PREFLIGHT_DIR) => join(dir, `${tier}.json`);

/** @param {string} tier @param {string} [dir] @returns {Proof | undefined} */
export function readProof(tier, dir = PREFLIGHT_DIR) {
  const file = proofPath(tier, dir);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

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
      posted: { type: "string", default: POSTED_RECORDS_DIR },
    },
  });
  const tier = tierOf(values.tier);
  const bundle = /** @type {string} */ (values.bundle);
  console.log(`preflight ${banner(tier)}`);
  if (!existsSync(bundle)) throw new CliError(`bundle not found: ${bundle}`);
  const digest = await digestFile(bundle);
  console.log(`bundle ${digest.keccak256} (${digest.bytes} bytes)`);

  const dirtyStatus = porcelain();
  if (tier.name === "prod") {
    const reasons = prodRefusals({
      porcelain: dirtyStatus,
      branch: branch(),
      remotes: remotesContainingHead(),
      testWorkerHash: readRecord(recordPath(/** @type {string} */ (values.posted), "test"))
        ?.workerHash,
      workerHash: digest.keccak256,
    });
    if (reasons.length > 0)
      throw new CliError(`prod preflight refuses:\n  - ${reasons.join("\n  - ")}`);
  }

  if (tier.public) {
    console.log("rebuilding from a clean export of HEAD…");
    const { results, odd } = await reproduce({
      build: process.env.WORKER_BUILD_CMD || DEFAULT_BUILD,
      bundle,
      runs: 2,
      cleanExport: true,
      ref: "HEAD",
      install: DEFAULT_INSTALL,
      keep: false,
    });
    if (odd !== undefined) throw new CliError("clean exports of HEAD are not byte-identical");
    const fromHead = results[0]?.keccak256;
    if (fromHead !== digest.keccak256)
      throw new CliError(
        `the bundle (${digest.keccak256}) is not what HEAD builds (${fromHead}): commit the worker's sources, rebuild, and retry`,
      );
    console.log(`✓ the bundle is what HEAD builds`);
  }

  /** @type {Proof} */
  const proof = {
    tier: tier.name,
    workerHash: digest.keccak256,
    bytes: digest.bytes,
    gitCommit: head(),
    dirty: dirtyStatus !== "",
    at: new Date().toISOString(),
  };
  mkdirSync(PREFLIGHT_DIR, { recursive: true });
  writeFileSync(proofPath(tier.name), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(
    `✓ preflight ${tier.name}: ${proof.workerHash} at ${proof.gitCommit.slice(0, 12)}${proof.dirty ? " (tree dirty)" : ""}`,
  );
}

if (isMain(import.meta.url)) runMain(main);
