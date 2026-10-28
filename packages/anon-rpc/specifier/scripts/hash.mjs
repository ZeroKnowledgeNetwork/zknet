#!/usr/bin/env node
// keccak-256 of a worker bundle's exact bytes: the value the specifier pins
// as workerHash() (SPEC §4).
//
// Usage:
//   node scripts/hash.mjs [--bundle <path>] [--json] [--write]
//
// --write records dist/worker.keccak256 ("0x<hash>  <name>") and
// dist/worker.provenance.json next to this project's other outputs, never
// inside the bundle's own directory. The provenance carries no timestamps, so
// two builds of one commit give identical provenance bytes too.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { contentPath, digestFile } from "./lib/digest.mjs";
import { DEFAULT_BUNDLE, DIST_DIR, WORKSPACE_DIR } from "./lib/paths.mjs";
import { CliError, isMain, runMain } from "./lib/proc.mjs";

/** @param {string[]} args */
function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: WORKSPACE_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** @param {string} cmd @param {string[]} args */
function version(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * What produced the bundle, as far as this workspace can tell: the commit, a
 * dirty-tree flag, the JS toolchain, and the lockfile digest that pins every
 * bundler input.
 * @param {import("./lib/digest.mjs").FileDigest} digest
 */
export async function provenance(digest) {
  const lockfile = join(WORKSPACE_DIR, "pnpm-lock.yaml");
  return {
    bundle: relative(WORKSPACE_DIR, digest.file),
    gitCommit: git(["rev-parse", "HEAD"]) ?? null,
    gitTreeClean: git(["status", "--porcelain"]) === "",
    toolchain: {
      node: process.version,
      pnpm: version("pnpm", ["--version"]),
      packageManager:
        JSON.parse(readFileSync(join(WORKSPACE_DIR, "package.json"), "utf8")).packageManager ??
        null,
    },
    inputs: { lockfileSha256: existsSync(lockfile) ? (await digestFile(lockfile)).sha256 : null },
    output: {
      bytes: digest.bytes,
      sha256: digest.sha256,
      keccak256: digest.keccak256,
      contentPath: contentPath(digest.keccak256),
    },
  };
}

/** @param {string[]} argv */
async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      bundle: { type: "string", default: process.env.WORKER_BUNDLE || DEFAULT_BUNDLE },
      json: { type: "boolean", default: false },
      write: { type: "boolean", default: false },
    },
  });
  const bundle = /** @type {string} */ (values.bundle);
  if (!existsSync(bundle))
    throw new CliError(`bundle not found: ${bundle} (build the worker, or pass --bundle)`);
  const digest = await digestFile(bundle);

  if (values.write) {
    mkdirSync(DIST_DIR, { recursive: true });
    writeFileSync(join(DIST_DIR, "worker.keccak256"), `${digest.keccak256}  ${basename(bundle)}\n`);
    writeFileSync(
      join(DIST_DIR, "worker.provenance.json"),
      `${JSON.stringify(await provenance(digest), null, 2)}\n`,
    );
  }
  if (values.json) console.log(JSON.stringify(digest, null, 2));
  else console.log(`${digest.keccak256}  ${bundle}`);
}

if (isMain(import.meta.url)) runMain(main);
