#!/usr/bin/env node
// Run a Foundry tool found the way every script here finds it (FOUNDRY_BIN,
// PATH, then ~/.foundry/bin), so Nx targets work from shells whose PATH lacks
// foundryup's install directory.
//
// Usage: node scripts/foundry.mjs forge|cast|anvil <args...>

import { spawnSync } from "node:child_process";
import { PROJECT_DIR } from "./lib/paths.mjs";
import { CliError, foundry, isMain, runMain } from "./lib/proc.mjs";

/** @param {string[]} argv */
async function main(argv) {
  const [tool, ...args] = argv;
  if (tool !== "forge" && tool !== "cast" && tool !== "anvil")
    throw new CliError("usage: foundry.mjs forge|cast|anvil <args...>");
  const r = spawnSync(foundry(tool), args, { cwd: PROJECT_DIR, stdio: "inherit" });
  if (r.error) throw new CliError(`${tool}: ${r.error.message}`);
  return r.status ?? 1;
}

if (isMain(import.meta.url)) runMain(main);
