#!/usr/bin/env node
// The whole local loop, end to end, through the real CLIs: store the bundle in
// the keccak resolver and serve it, start anvil, deploy the specifier, deploy
// again (must be a no-op on the same address), boot-resolve it with
// verify.mjs, move it to a second bundle with --update and resolve again, and
// finally stop both services. Uses its own ports and deployment record, so a
// developer's running local chain is untouched.
//
// Usage:
//   node scripts/e2e.mjs [--bundle <path>]      default: $WORKER_BUNDLE, else the
//                                               worker bundle if built, else the fixture

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_BUNDLE, FIXTURE_BUNDLE, PROJECT_DIR, STATE_DIR } from "./lib/paths.mjs";
import { CliError, isMain, runMain } from "./lib/proc.mjs";

const ANVIL_PORT = "18545";
const RESOLVER_PORT = "18546";
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const DEPLOYMENTS = join(STATE_DIR, "e2e-deployments");

/**
 * Run one of this project's scripts, echoing its output, and return it.
 * @param {string} script
 * @param {string[]} args
 * @param {{ expectExit?: number }} [opts]
 */
function step(script, args, { expectExit = 0 } = {}) {
  console.log(`\n$ node scripts/${script} ${args.join(" ")}`);
  const r = spawnSync(process.execPath, [join(PROJECT_DIR, "scripts", script), ...args], {
    cwd: PROJECT_DIR,
    encoding: "utf8",
    env: { ...process.env, RPC_URL, RESOLVER_URLS: "", WORKER_BUNDLE: "" },
  });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.status !== expectExit)
    throw new CliError(`${script} exited ${r.status}, expected ${expectExit}`);
  return r.stdout;
}

/** @param {string} out @returns {string} the address a deploy printed last */
const addressOf = (out) => {
  const last = out.trim().split("\n").pop() ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(last))
    throw new CliError(`deploy did not print an address: ${last}`);
  return last;
};

/** @param {string[]} argv */
async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      bundle: {
        type: "string",
        default:
          process.env.WORKER_BUNDLE ||
          (existsSync(DEFAULT_BUNDLE) ? DEFAULT_BUNDLE : FIXTURE_BUNDLE),
      },
    },
  });
  const bundle = /** @type {string} */ (values.bundle);
  const port = ["--port", RESOLVER_PORT];
  const scratch = mkdtempSync(join(tmpdir(), "zknet-specifier-e2e-"));
  rmSync(DEPLOYMENTS, { recursive: true, force: true });
  try {
    step("resolver.mjs", ["put", "--bundle", bundle, ...port]);
    step("resolver.mjs", ["start", ...port]);
    step("anvil.mjs", ["start", "--port", ANVIL_PORT]);

    const deploy = ["--rpc-url", RPC_URL, "--deployments", DEPLOYMENTS];
    const resolverOf = (/** @type {string} */ b) =>
      step("resolver.mjs", ["put", "--bundle", b, ...port]).trim();

    const first = addressOf(
      step("deploy.mjs", ["--bundle", bundle, "--resolver", resolverOf(bundle), ...deploy]),
    );
    const again = step("deploy.mjs", [
      "--bundle",
      bundle,
      "--resolver",
      resolverOf(bundle),
      ...deploy,
    ]);
    if (!again.includes("already deployed and up to date") || addressOf(again) !== first) {
      throw new CliError("second deploy was not an idempotent no-op on the same address");
    }
    step("verify.mjs", ["--rpc-url", RPC_URL, "--deployments", DEPLOYMENTS, "--bundle", bundle]);

    // A second bundle: plain deploy refuses to touch the recorded specifier,
    // --update moves it in place (same address), and it resolves again.
    const next = join(scratch, "next-worker.js");
    writeFileSync(next, Buffer.concat([readFileSync(bundle), Buffer.from("\n// next version\n")]));
    step("deploy.mjs", ["--bundle", next, "--resolver", resolverOf(next), ...deploy], {
      expectExit: 1,
    });
    const updated = addressOf(
      step("deploy.mjs", ["--bundle", next, "--resolver", resolverOf(next), "--update", ...deploy]),
    );
    if (updated !== first)
      throw new CliError(`--update moved the specifier from ${first} to ${updated}`);
    step("verify.mjs", ["--rpc-url", RPC_URL, "--deployments", DEPLOYMENTS, "--bundle", next]);
    // The old bundle no longer matches the pin.
    step("verify.mjs", ["--rpc-url", RPC_URL, "--deployments", DEPLOYMENTS, "--bundle", bundle], {
      expectExit: 1,
    });

    console.log(`\n✅ specifier e2e passed (specifier ${first} on local anvil, chain ${RPC_URL})`);
  } finally {
    step("anvil.mjs", ["stop", "--port", ANVIL_PORT]);
    step("resolver.mjs", ["stop", ...port]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) runMain(main);
