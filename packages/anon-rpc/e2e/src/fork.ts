// The fork tier's moving parts: a harness built from an anon-rpc checkout, a
// self-signed https origin, a Chromium profile with Local Network Access
// grants seeded as persisted site settings, and a WalletShield stand-in that
// can listen on a LAN address.

import { chromium, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { RUN_DIR } from "./paths.js";

export interface ForkHarness {
  /** dist/host.js of the checkout's browser-harness, built just now. */
  file: string;
  label: string;
  /** `git describe` of the checkout, for the report. */
  revision: string;
}

/**
 * Build impl/browser-harness in `repo` (an anon-rpc checkout whose
 * dependencies are installed) and return its entry. Refuses a checkout
 * without WorkerInit.network support (SPEC §6.1, where the browser harness
 * validates and delegates in src/host/local-network.ts), which is the point
 * of this tier.
 */
export function buildForkHarness(repo: string): ForkHarness {
  const dir = join(repo, "impl/browser-harness");
  if (!existsSync(join(dir, "src/host/AnonRpcWorker.ts"))) {
    throw new Error(
      `${repo} is not an anon-rpc checkout (no impl/browser-harness/src/host/AnonRpcWorker.ts)`,
    );
  }
  const support = join(dir, "src/host/local-network.ts");
  if (!existsSync(support) || !readFileSync(support, "utf8").includes("networkSpaces")) {
    throw new Error(
      `${repo} has no WorkerInit.network support: check out feat/worker-network-policy (or a branch with it)`,
    );
  }
  // The browser harness imports @anon-rpc/harness-core, whose dist it does
  // not build itself.
  execFileSync("npm", ["run", "build"], { cwd: join(repo, "impl/harness-core"), stdio: "pipe" });
  execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "pipe" });
  const revision = execFileSync("git", ["describe", "--always", "--dirty", "--all", "--long"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  return { file: join(dir, "dist/host.js"), label: `fork:${revision}`, revision };
}

/** A throwaway self-signed certificate for one IP address, and optionally one DNS name. */
export function selfSigned(ip = "127.0.0.1", dnsName?: string): { key: string; cert: string } {
  mkdirSync(RUN_DIR, { recursive: true });
  const dir = mkdtempSync(join(RUN_DIR, "tls-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        `/CN=${dnsName ?? ip}`,
        "-addext",
        `subjectAltName=IP:${ip}${dnsName ? `,DNS:${dnsName}` : ""}`,
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { stdio: "pipe" },
    );
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** This host's first RFC 1918 IPv4 address, if it has one. */
export function lanAddress(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return undefined;
}

export interface PublicProfile {
  context: BrowserContext;
  close(): Promise<void>;
}

/**
 * A Chromium that treats `origin` as a public page — a CONTROL: the override
 * flag stands in for a page served from the internet — with, when `grant` is
 * set, Local Network Access granted to it the way the settings UI stores it
 * (persisted site-settings exceptions). Not a CDP permission override: that
 * bypasses frame delegation, which is what this tier tests.
 */
export async function publicProfile(origin: string, grant: boolean): Promise<PublicProfile> {
  const port = new URL(origin).port;
  mkdirSync(RUN_DIR, { recursive: true });
  const dir = mkdtempSync(join(RUN_DIR, "chromium-"));
  if (grant) {
    const exceptions = {
      loopback_network: { [`${origin},*`]: { setting: 1 } },
      local_network: { [`${origin},*`]: { setting: 1 } },
    };
    mkdirSync(join(dir, "Default"), { recursive: true });
    writeFileSync(
      join(dir, "Default", "Preferences"),
      JSON.stringify({ profile: { content_settings: { exceptions } } }),
    );
  }
  const context = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    headless: true,
    ...(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {}),
    args: [`--ip-address-space-overrides=127.0.0.1:${port}=public`],
    ignoreHTTPSErrors: true,
  });
  return {
    context,
    close: async () => {
      await context.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface LanStub {
  url: string;
  posts: number;
  close(): Promise<void>;
}

/**
 * A minimal WalletShield stand-in on any address (the transport's stub binds
 * loopback only): local preflights and health, a JSON-RPC result for POSTs.
 */
export async function startLanStub(host: string): Promise<LanStub> {
  const stub: LanStub = { url: "", posts: 0, close: async () => {} };
  const server: Server = createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    if (req.method === "OPTIONS") {
      res.setHeader("access-control-allow-methods", "GET, POST");
      res.setHeader(
        "access-control-allow-headers",
        req.headers["access-control-request-headers"] ?? "",
      );
      res.writeHead(204).end();
    } else if (req.method === "GET" && req.url === "/_/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"version":"lan-stub"}');
    } else {
      if (req.method === "POST") stub.posts++;
      req.resume();
      res
        .writeHead(200, { "content-type": "application/json" })
        .end('{"jsonrpc":"2.0","id":1,"result":"0x1a4"}');
    }
  });
  await new Promise<void>((r) => server.listen(0, host, () => r()));
  stub.url = `http://${host}:${(server.address() as AddressInfo).port}`;
  stub.close = () => new Promise<void>((r) => server.close(() => r()));
  return stub;
}
