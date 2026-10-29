#!/usr/bin/env node
// Put the bundle where a tier's resolvers serve it from.
//
// Usage:
//   node scripts/publish.mjs --tier dev|test|prod [--bundle <path>] [--out <dir>] [--config <file>]
//
//   dev        copies the bundle into the local resolver's store (resolver-put)
//   test|prod  stages a static site for Cloudflare Pages at .state/publish/<tier>
//              and prints the `wrangler pages deploy` command; it never runs it
//
// The staged site is cumulative: every bundle ever staged for the tier stays,
// because a Pages deploy replaces the whole site and a specifier, or a harness
// that booted from it, may still name an older hash. Layout:
//
//   keccak/<hash[0:2]>/<hash[2:]>   the bundle at its content address
//   _headers                        octet-stream, immutable, no-transform, CORS
//   404.html                        so a missing hash is a 404, not a fallback page
//
// `no-transform` and octet-stream keep Cloudflare from compressing the body:
// resolvers must serve the bytes as-is (no Content-Encoding).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { contentPath, digestFile } from "./lib/digest.mjs";
import { keccak256Hex } from "./lib/keccak.mjs";
import {
  DEFAULT_BUNDLE,
  DEFAULT_RESOLVER_PORT,
  LOCAL_CONFIG,
  PUBLISH_DIR,
  RESOLVER_STORE,
  WORKSPACE_DIR,
} from "./lib/paths.mjs";
import { CliError, isMain, runMain } from "./lib/proc.mjs";
import { banner, expandResolvers, loadTierConfig, tierOf } from "./lib/tiers.mjs";
import { put, resolverUrl } from "./resolver.mjs";

export const HEADERS = `/keccak/*
  Content-Type: application/octet-stream
  Cache-Control: public, max-age=31536000, immutable, no-transform
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff
`;

export const NOT_FOUND = "<!doctype html><title>404</title><p>No bundle at this address.</p>\n";

/**
 * Stage one bundle into a Pages site directory, keeping what is already there.
 * @param {string} bundle
 * @param {string} site
 * @returns {Promise<{ workerHash: string, staged: string[] }>} the new hash and every hash the site holds
 */
export async function stage(bundle, site) {
  const digest = await digestFile(bundle);
  const target = join(site, "keccak", contentPath(digest.keccak256));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(bundle, target);
  writeFileSync(join(site, "_headers"), HEADERS);
  writeFileSync(join(site, "404.html"), NOT_FOUND);

  /** @type {string[]} */
  const staged = [];
  const root = join(site, "keccak");
  for (const hi of readdirSync(root).sort()) {
    for (const lo of readdirSync(join(root, hi)).sort()) {
      const hash = `0x${hi}${lo}`;
      if (keccak256Hex(readFileSync(join(root, hi, lo))) !== hash)
        throw new CliError(`staged file keccak/${hi}/${lo} does not hash to its address`);
      staged.push(hash);
    }
  }
  return { workerHash: digest.keccak256, staged };
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
      out: { type: "string" },
      config: { type: "string", default: LOCAL_CONFIG },
    },
  });
  const tier = tierOf(values.tier);
  const bundle = /** @type {string} */ (values.bundle);
  console.log(`publish ${banner(tier)}`);
  if (!existsSync(bundle)) throw new CliError(`bundle not found: ${bundle}`);

  if (!tier.public) {
    const digest = await put(bundle, RESOLVER_STORE);
    console.log(
      `✓ in the local resolver store: ${resolverUrl("127.0.0.1", DEFAULT_RESOLVER_PORT, digest.keccak256)}`,
    );
    return;
  }

  const config = loadTierConfig(tier, /** @type {string} */ (values.config));
  const site = values.out ?? join(PUBLISH_DIR, tier.name);
  const { workerHash, staged } = await stage(bundle, site);
  const rel = relative(WORKSPACE_DIR, site);
  console.log(`✓ staged ${workerHash} in ${rel} (${staged.length} bundle(s) on the site)`);
  console.log("resolvers the specifier will pin:");
  for (const r of expandResolvers(config.resolvers, workerHash)) console.log(`  ${r}`);
  const project = config.pages?.project ?? "<pages project>";
  console.log("\nupload it with your Cloudflare credentials (from the repository root):");
  console.log(`  wrangler pages deploy ${rel} --project-name ${project} --branch main`);
  console.log(
    `then: nx run anon-rpc-specifier:deploy:${tier.name}   (checks every resolver serves the bytes)`,
  );
}

if (isMain(import.meta.url)) runMain(main);
