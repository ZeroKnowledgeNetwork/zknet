// The deployment record of a public tier.
//
// It names what is live: address, chain, contract, owner, creation, the pinned
// workerHash and the commit the bundle was built from. It never holds resolver
// URLs. `updates` is an append-only, informational history that the operator
// curates by hand before posting (pruning test noise is expected), so no code
// reads it: tooling depends on the top-level fields only, and a record whose
// `updates` is missing or empty works the same.
//
// Two places hold one: the working record, .state/records/<tier>.json
// (untracked), which deploy reads and writes; and the posted record,
// deployments/<tier>.json, which the operator copies from the working one and
// commits when a deployment is for public consumption. Nothing writes the
// posted record. A record started from --address has no `creation`: the chain
// holds it, and nothing here needs it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CliError } from "./proc.mjs";

/**
 * @typedef {object} BundleRef
 * @property {string} file
 * @property {number} bytes
 * @property {string} gitCommit  the commit a clean export reproduces this bundle from
 * @property {boolean} dirty     whether the working tree had uncommitted changes at deploy time
 */

/**
 * @typedef {object} TierRecord
 * @property {string} tier
 * @property {number} chainId
 * @property {string} address
 * @property {string} contract
 * @property {string} codehash
 * @property {string} owner
 * @property {{ tx: string, block: number }} [creation]  absent when the record was started from --address
 * @property {string} workerHash
 * @property {BundleRef} bundle
 * @property {{ tx: string, block: number, workerHash: string, gitCommit: string }[]} [updates]
 */

/** @param {string} dir @param {string} tier */
export const recordPath = (dir, tier) => join(dir, `${tier}.json`);

/**
 * Refuse a record that carries a URL anywhere, or lacks a top-level field.
 * @param {unknown} record
 * @returns {TierRecord}
 */
export function checkRecord(record) {
  const r = /** @type {Record<string, unknown>} */ (record);
  for (const key of ["tier", "address", "contract", "codehash", "owner", "workerHash"]) {
    if (typeof r?.[key] !== "string") throw new CliError(`record: ${key} missing`);
  }
  if (typeof r.chainId !== "number") throw new CliError("record: chainId missing");
  if (r.creation !== undefined && typeof (/** @type {any} */ (r.creation)?.tx) !== "string")
    throw new CliError("record: creation.tx missing");
  if ("resolvers" in r) throw new CliError("record: resolvers do not belong in a committed record");
  const url = JSON.stringify(record).match(/[a-z][a-z0-9+.-]*:\/\/[^"]*/i);
  if (url) throw new CliError(`record: holds a URL (${url[0]}); records name no resolver`);
  return /** @type {TierRecord} */ (record);
}

/** @param {string} file @returns {TierRecord | undefined} */
export function readRecord(file) {
  if (!existsSync(file)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError(`${file}: ${error instanceof Error ? error.message : error}`);
  }
  return checkRecord(parsed);
}

/** @param {string} file @param {TierRecord} record */
export function writeRecord(file, record) {
  checkRecord(record);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * The record after a creation: a new contract, so no history.
 * @param {Omit<TierRecord, 'updates' | 'contract'>} fields
 * @returns {TierRecord}
 */
export function createdRecord(fields) {
  return { ...fields, contract: "WorkerSpecifier", updates: [] };
}

/**
 * The record after a setWorker on the same address: the top level moves to
 * the new pin and one entry is appended to whatever history is there
 * (possibly none, after hand curation).
 * @param {TierRecord} previous
 * @param {{ tx: string, block: number, workerHash: string, bundle: BundleRef, owner: string }} update
 * @returns {TierRecord}
 */
export function updatedRecord(previous, update) {
  const history = Array.isArray(previous.updates) ? previous.updates : [];
  return {
    ...previous,
    owner: update.owner,
    workerHash: update.workerHash,
    bundle: update.bundle,
    updates: [
      ...history,
      {
        tx: update.tx,
        block: update.block,
        workerHash: update.workerHash,
        gitCommit: update.bundle.gitCommit,
      },
    ],
  };
}

/**
 * @typedef {object} FoundRecord
 * @property {TierRecord} [record]  the record deploy acts on
 * @property {string} [file]        where it was read from
 * @property {TierRecord} [posted]  the posted record, when it names another address than the working one
 */

/**
 * The record a public tier acts on: the working record when there is one,
 * else the posted one. Callers print which file and address they used, so a
 * plan always shows the contract it targets.
 * @param {string} tier
 * @param {string} workingDir
 * @param {string} postedDir
 * @returns {FoundRecord}
 */
export function findRecord(tier, workingDir, postedDir) {
  const workingFile = recordPath(workingDir, tier);
  const postedFile = recordPath(postedDir, tier);
  const working = readRecord(workingFile);
  const posted = readRecord(postedFile);
  if (working) {
    const differs = posted && posted.address.toLowerCase() !== working.address.toLowerCase();
    return { record: working, file: workingFile, ...(differs ? { posted } : {}) };
  }
  if (posted) return { record: posted, file: postedFile };
  return {};
}
