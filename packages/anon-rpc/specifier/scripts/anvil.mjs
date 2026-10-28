#!/usr/bin/env node
// A local anvil chain in the background, owned by .state/anvil-<port>.pid.
//
// Usage:
//   node scripts/anvil.mjs start [--port 8545]   idempotent: a running chain is left alone
//   node scripts/anvil.mjs stop
//   node scripts/anvil.mjs status                exit 0 running, 3 stopped

import { join } from "node:path";
import { parseArgs } from "node:util";
import { STATE_DIR } from "./lib/paths.mjs";
import { CliError, Daemon, foundry, isMain, runMain } from "./lib/proc.mjs";
import { answers } from "./lib/rpc.mjs";

/** @param {number} port */
export function anvilDaemon(port) {
  return new Daemon("anvil", join(STATE_DIR, `anvil-${port}.pid`), () =>
    answers(`http://127.0.0.1:${port}`),
  );
}

/** @param {string[]} argv */
async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { port: { type: "string", default: process.env.ANVIL_PORT || "8545" } },
  });
  const port = Number(values.port);
  const daemon = anvilDaemon(port);
  switch (positionals[0]) {
    case "start": {
      const { pid, started } = await daemon.start(foundry("anvil"), [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ]);
      console.log(
        `anvil ${started ? "started" : "already running"} (pid ${pid}) at http://127.0.0.1:${port}`,
      );
      return;
    }
    case "stop":
      console.log((await daemon.stop()) ? "anvil stopped" : "anvil was not running");
      return;
    case "status": {
      const pid = daemon.pid();
      console.log(
        pid === undefined
          ? "anvil not running"
          : `anvil running (pid ${pid}) at http://127.0.0.1:${port}`,
      );
      return pid === undefined ? 3 : 0;
    }
    default:
      throw new CliError("usage: anvil.mjs start|stop|status [--port N]");
  }
}

if (isMain(import.meta.url)) runMain(main);
