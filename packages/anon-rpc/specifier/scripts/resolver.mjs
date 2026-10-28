#!/usr/bin/env node
// Local keccak resolver: serves worker bundles content-addressed, so a URL
// can only ever name one sequence of bytes.
//
// Store layout is EF's `keccak` resolver branch, <hash[0:2]>/<hash[2:]> over
// the 64 hex digits; the HTTP path adds a /keccak prefix, the form of the
// SPEC §4.1 kps example (`.../keccak/19/4f04...`):
//
//   GET /keccak/<hash[0:2]>/<hash[2:]>  ->  200, body = the bundle bytes
//
// Resolver semantics a harness checks (SPEC §4.1/§4.2): a stored bundle is
// 200 with the exact bytes as body; anything else is a non-200 and fails that
// resolver; nothing ever redirects; no Content-Encoding or Transfer-Encoding,
// so the body is the bundle as-is. The server also re-hashes a file before
// serving it, so a corrupted store answers 500 rather than wrong bytes.
//
// Usage:
//   node scripts/resolver.mjs put    [--bundle <path>] [--store <dir>] [--port N]
//   node scripts/resolver.mjs serve  [--store <dir>] [--port N] [--host H]
//   node scripts/resolver.mjs start  [--store <dir>] [--port N] [--host H]   (background)
//   node scripts/resolver.mjs stop | status

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { contentPath, digestFile } from "./lib/digest.mjs";
import { keccak256Hex } from "./lib/keccak.mjs";
import { DEFAULT_BUNDLE, DEFAULT_RESOLVER_PORT, RESOLVER_STORE, STATE_DIR } from "./lib/paths.mjs";
import { CliError, Daemon, isMain, runMain } from "./lib/proc.mjs";

const ROUTE = /^\/keccak\/([0-9a-f]{2})\/([0-9a-f]{62})$/;

/**
 * The resolver as a node:http server over a store directory.
 * @param {string} store
 * @param {{ log?: (line: string) => void }} [opts]
 */
export function createResolverServer(store, { log = () => {} } = {}) {
  return createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const reply = (
      /** @type {number} */ status,
      /** @type {Record<string, string | number>} */ headers = {},
    ) => {
      log(`${req.method} ${path} ${status}`);
      res.writeHead(status, { "access-control-allow-origin": "*", ...headers });
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      reply(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    const match = ROUTE.exec(path);
    if (match === null) {
      reply(404);
      res.end();
      return;
    }
    let bytes;
    try {
      bytes = await readFile(join(store, match[1] ?? "", match[2] ?? ""));
    } catch {
      reply(404);
      res.end();
      return;
    }
    if (keccak256Hex(bytes) !== `0x${match[1]}${match[2]}`) {
      reply(500);
      res.end();
      return;
    }
    reply(200, {
      "content-type": "text/javascript",
      "content-length": bytes.byteLength,
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  });
}

/** @param {string} host @param {number} port @param {string} keccak256 */
export function resolverUrl(host, port, keccak256) {
  return `http://${host}:${port}/keccak/${contentPath(keccak256)}`;
}

/**
 * Copy a bundle into the store at its content address.
 * @param {string} bundle
 * @param {string} store
 */
export async function put(bundle, store) {
  if (!existsSync(bundle))
    throw new CliError(`bundle not found: ${bundle} (build the worker, or pass --bundle)`);
  const digest = await digestFile(bundle);
  const target = join(store, contentPath(digest.keccak256));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(bundle, target);
  return digest;
}

/** @param {string} host @param {number} port */
export function resolverDaemon(host, port) {
  return new Daemon("resolver", join(STATE_DIR, `resolver-${port}.pid`), async () => {
    try {
      const resp = await fetch(`http://${host}:${port}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(1000),
      });
      await resp.arrayBuffer();
      return resp.status === 404;
    } catch {
      return false;
    }
  });
}

/** @param {string[]} argv */
async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      bundle: { type: "string", default: process.env.WORKER_BUNDLE || DEFAULT_BUNDLE },
      store: { type: "string", default: RESOLVER_STORE },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: process.env.RESOLVER_PORT || String(DEFAULT_RESOLVER_PORT) },
    },
  });
  const store = /** @type {string} */ (values.store);
  const host = /** @type {string} */ (values.host);
  const port = Number(values.port);
  const daemon = resolverDaemon(host, port);

  switch (positionals[0]) {
    case "put": {
      const digest = await put(/** @type {string} */ (values.bundle), store);
      console.log(resolverUrl(host, port, digest.keccak256));
      return;
    }
    case "serve": {
      const server = createResolverServer(store, { log: (line) => console.log(line) });
      server.listen(port, host, () =>
        console.log(`resolver serving ${store} at http://${host}:${port}/keccak/`),
      );
      await new Promise((resolve) => server.on("close", resolve));
      return;
    }
    case "start": {
      const self = new URL(import.meta.url).pathname;
      const args = [self, "serve", "--store", store, "--host", host, "--port", String(port)];
      const { pid, started } = await daemon.start(process.execPath, args);
      console.log(
        `resolver ${started ? "started" : "already running"} (pid ${pid}) at http://${host}:${port}/keccak/`,
      );
      return;
    }
    case "stop":
      console.log((await daemon.stop()) ? "resolver stopped" : "resolver was not running");
      return;
    case "status": {
      const pid = daemon.pid();
      console.log(pid === undefined ? "resolver not running" : `resolver running (pid ${pid})`);
      return pid === undefined ? 3 : 0;
    }
    default:
      throw new CliError(
        "usage: resolver.mjs put|serve|start|stop|status [--bundle P] [--store D] [--host H] [--port N]",
      );
  }
}

if (isMain(import.meta.url)) runMain(main);
