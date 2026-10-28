// Child processes: Foundry tool lookup, captured runs, and detached daemons
// tracked by a pid file (anvil and the resolver share the lifecycle).

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PROJECT_DIR } from "./paths.mjs";

export class CliError extends Error {}

/**
 * Absolute path of a Foundry binary: $FOUNDRY_BIN, then PATH, then foundryup's
 * default install directory (~/.foundry/bin), which is often not on the PATH
 * of non-interactive shells such as Nx executors.
 * @param {"forge" | "cast" | "anvil"} name
 */
export function foundry(name) {
  const dirs = [
    process.env.FOUNDRY_BIN,
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".foundry/bin"),
  ];
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  throw new CliError(
    `${name} not found: install Foundry (https://getfoundry.sh) or set FOUNDRY_BIN`,
  );
}

/**
 * Run a command to completion and return its trimmed stdout.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, echo?: boolean }} [opts]
 * @returns {Promise<string>}
 */
export function run(cmd, args, { cwd = PROJECT_DIR, env = process.env, echo = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (b) => {
      out += b;
      if (echo) process.stdout.write(b);
    });
    p.stderr.on("data", (b) => {
      err += b;
      if (echo) process.stderr.write(b);
    });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(
            new CliError(
              `${cmd.split("/").pop()} ${args[0]} exited ${code}:\n${(err || out).trim()}`,
            ),
          ),
    );
  });
}

/**
 * Run a command that may ask the operator for a keystore password: stdin and
 * stderr stay on the terminal, so Foundry's prompt reaches them and their
 * answer reaches Foundry without passing through this process. Only stdout
 * (the --json result) is captured.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
export function runSigning(cmd, args, { cwd = PROJECT_DIR, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["inherit", "pipe", "inherit"],
    });
    let out = "";
    p.stdout.on("data", (b) => {
      out += b;
    });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new CliError(`${cmd.split("/").pop()} ${args[0]} exited ${code}`)),
    );
  });
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A long-running background process owned by a pid file. start() is
 * idempotent: a live recorded process that passes `ready` is left alone.
 */
export class Daemon {
  /**
   * @param {string} name                 label in messages
   * @param {string} pidFile
   * @param {() => Promise<boolean>} ready resolves true once the service answers
   */
  constructor(name, pidFile, ready) {
    this.name = name;
    this.pidFile = pidFile;
    this.logFile = pidFile.replace(/\.pid$/, ".log");
    this.ready = ready;
  }

  /** @returns {number | undefined} pid of the recorded process, if it is still running */
  pid() {
    if (!existsSync(this.pidFile)) return undefined;
    const pid = Number(readFileSync(this.pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
  }

  /**
   * @param {string} cmd
   * @param {string[]} args
   * @param {number} [timeoutMs]
   * @returns {Promise<{ pid: number, started: boolean }>}
   */
  async start(cmd, args, timeoutMs = 15_000) {
    const existing = this.pid();
    if (existing !== undefined) {
      if (await this.ready()) return { pid: existing, started: false };
      throw new CliError(
        `${this.name}: pid ${existing} is running but not answering; stop it first`,
      );
    }
    if (await this.ready()) {
      throw new CliError(
        `${this.name}: something else is already answering on its port; refusing to start a second`,
      );
    }
    mkdirSync(dirname(this.pidFile), { recursive: true });
    const log = openSync(this.logFile, "w");
    const child = spawn(cmd, args, {
      cwd: PROJECT_DIR,
      detached: true,
      stdio: ["ignore", log, log],
    });
    if (child.pid === undefined) throw new CliError(`${this.name}: failed to spawn ${cmd}`);
    child.unref();
    writeFileSync(this.pidFile, `${child.pid}\n`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!alive(child.pid)) break;
      if (await this.ready()) return { pid: child.pid, started: true };
      await sleep(100);
    }
    await this.stop();
    throw new CliError(
      `${this.name}: did not become ready within ${timeoutMs} ms (log: ${this.logFile})`,
    );
  }

  /** @returns {Promise<boolean>} true if a process was stopped */
  async stop() {
    const pid = this.pid();
    rmSync(this.pidFile, { force: true });
    if (pid === undefined) return false;
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    if (alive(pid)) process.kill(pid, "SIGKILL");
    return true;
  }
}

/** @param {string} moduleUrl import.meta.url of the caller @returns {boolean} true when run as the entry point */
export function isMain(moduleUrl) {
  return (
    process.argv[1] !== undefined && moduleUrl === pathToFileURL(realpathSync(process.argv[1])).href
  );
}

/**
 * Run an async CLI main, mapping CliError to a one-line message and exit 1.
 * @param {(argv: string[]) => Promise<number | void>} main
 */
export function runMain(main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (error) => {
      if (error instanceof CliError) console.error(`error: ${error.message}`);
      else console.error(error);
      process.exit(1);
    },
  );
}
