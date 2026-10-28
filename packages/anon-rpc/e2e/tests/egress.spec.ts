// Egress control: the ZKNet worker reaches the network only through its
// configured WalletShield. Each test opens the host page in its own browser
// context guarded by both layers of src/egress-proxy.ts, from the first
// navigation on.
//
// Positive: the real worker, booted and called, contacts nothing but the bed
// (page, specifier RPC, resolver) and, once ready, only its WalletShield.
// Negative: a hash-pinned leaky worker's ambient fetches and WebSocket are all
// flagged, and a trap server confirms they really left the sandbox.

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { startStubWalletShield, type StubWalletShield } from "@zknet/anon-rpc-transport/testing";
import { startChain, type Chain } from "../src/chain.js";
import {
  originOfUrl,
  startEgressProxy,
  violations,
  type EgressEvent,
  type EgressProxy,
} from "../src/egress-proxy.js";
import { bundlePage, pinnedHarness, servePage, type PageServer } from "../src/page.js";
import { E2E_DIR, WORKER_BUNDLE } from "../src/paths.js";

const RPC_BODY = '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}';

let chain: Chain;
let stub: StubWalletShield;
let site: PageServer;
let zknet: string;
let leaky: string;
let trap: Server;
let trapPort: number;
const trapHits: string[] = [];

test.beforeAll(async () => {
  chain = await startChain();
  zknet = await chain.deploy(WORKER_BUNDLE);
  leaky = await chain.deploy(join(E2E_DIR, "fixtures/leaky-worker.js"));
  stub = await startStubWalletShield();
  site = await servePage(await bundlePage(pinnedHarness()));
  // Where a leak lands if it gets out: records plain requests and WebSocket handshakes.
  trap = createServer((req, res) => {
    trapHits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "access-control-allow-origin": "*" }).end("trapped");
  });
  trap.on("upgrade", (req, socket) => {
    trapHits.push(`UPGRADE ${req.url}`);
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  await new Promise<void>((r) => trap.listen(0, "127.0.0.1", () => r()));
  trapPort = (trap.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await site?.close();
  await stub?.close();
  await new Promise<void>((r) => (trap ? trap.close(() => r()) : r()));
  await chain?.stop();
});

interface Guard {
  context: BrowserContext;
  proxy: EgressProxy;
  /** Both layers: proxy events, then browser events. */
  events(): EgressEvent[];
  close(): Promise<void>;
}

/**
 * The proxy's bypass list: exactly the allowed origins go direct (so their
 * fetches keep a known address space), and `<-loopback>` sends every other
 * loopback port and `localhost` alias through the proxy.
 */
const direct = (origins: string[]) =>
  ["<-loopback>", ...origins.map((o) => new URL(o).host)].join(",");

/** A browser context whose every request is recorded. */
async function guarded(browser: Browser, bypass = direct([...bed(), stub.url])): Promise<Guard> {
  const proxy = await startEgressProxy();
  const context = await browser.newContext({ proxy: { server: proxy.url, bypass } });
  const seen: EgressEvent[] = [];
  context.on("request", (r) => {
    const url = r.url();
    const origin = /^https?:/.test(url) ? originOfUrl(url) : url;
    seen.push({ kind: "browser", method: r.method(), origin, url, forwarded: false });
  });
  return {
    context,
    proxy,
    events: () => [...proxy.events, ...seen],
    close: async () => {
      await context.close();
      await proxy.close();
    },
  };
}

async function open(guard: Guard): Promise<Page> {
  const page = await guard.context.newPage();
  await page.goto(`${site.origin}/`);
  await page.waitForFunction(() => window.e2e !== undefined);
  return page;
}

const bed = () => [site.origin, chain.rpcUrl, chain.resolverOrigin];

function bootZknet(page: Page) {
  return page.evaluate((req) => window.e2e.boot(req), {
    id: "w",
    address: zknet,
    rpcUrl: chain.rpcUrl,
    config: { walletshield: stub.url },
    readyTimeoutMs: 30_000,
  });
}

// A public provider URL: the worker still contacts only WalletShield, which
// carries the URL to the exit inside the mixnet.
function call(page: Page) {
  return page.evaluate((req) => window.e2e.fetch(req), {
    id: "w",
    url: "https://ethereum-rpc.publicnode.com",
    body: RPC_BODY,
    timeoutMs: 20_000,
  });
}

test("the ZKNet worker reaches only its WalletShield", async ({ browser }) => {
  const guard = await guarded(browser);
  try {
    const page = await open(guard);
    expect((await bootZknet(page)).ok).toBe(true);
    const readyAt = guard.events().filter((e) => e.kind === "browser").length;
    for (let i = 0; i < 3; i++) expect((await call(page)).status).toBe(200);

    const events = guard.events();
    // The browser layer really saw the worker's calls; the check would be vacuous otherwise.
    const calls = events.filter(
      (e) => e.kind === "browser" && e.origin === stub.url && e.method === "POST",
    );
    expect(calls).toHaveLength(3);
    expect(violations(events, [...bed(), stub.url])).toEqual([]);
    expect(guard.proxy.events).toEqual([]); // nothing beyond the allowed origins at all
    // Once ready, the only origin contacted is WalletShield.
    const after = events.filter((e) => e.kind === "browser").slice(readyAt);
    expect(new Set(after.map((e) => e.origin))).toEqual(new Set([stub.url]));
  } finally {
    await guard.close();
  }
});

test("a leaky worker is flagged: ambient fetches, a localhost alias, a public host, a WebSocket", async ({
  browser,
}) => {
  const guard = await guarded(browser);
  trapHits.length = 0;
  const stubPort = new URL(stub.url).port;
  const leaks = {
    fetches: [
      `http://127.0.0.1:${trapPort}/leak`, // another loopback origin
      `http://localhost:${stubPort}/_/health`, // an alias of the allowed WalletShield port is another origin
      "https://rpc.leak.invalid/", // a public host
    ],
    websockets: [`ws://127.0.0.1:${trapPort}/ws`],
  };
  try {
    const page = await open(guard);
    const booted = await page.evaluate((req) => window.e2e.boot(req), {
      id: "leaky",
      address: leaky,
      rpcUrl: chain.rpcUrl,
      config: leaks,
      readyTimeoutMs: 30_000,
    });
    expect(booted.ok).toBe(true);
    const report = await page.evaluate((req) => window.e2e.fetch(req), {
      id: "leaky",
      url: "/",
      method: "GET",
      timeoutMs: 10_000,
    });
    const outcomes = JSON.parse(report.bodyText ?? "[]") as { url: string; outcome: string }[];

    const flagged = violations(guard.events(), [...bed(), stub.url]).map(
      (e) => `${e.kind} ${e.origin}`,
    );
    expect(flagged).toEqual(
      expect.arrayContaining([
        `http http://127.0.0.1:${trapPort}`,
        `browser http://127.0.0.1:${trapPort}`,
        `http http://localhost:${stubPort}`,
        `browser http://localhost:${stubPort}`,
        "connect rpc.leak.invalid:443",
        `connect 127.0.0.1:${trapPort}`, // the WebSocket's tunnel
      ]),
    );
    // The leaks were real: the trap saw the fetch and the WebSocket handshake; the public host was refused.
    expect(trapHits).toEqual(expect.arrayContaining(["GET /leak", "UPGRADE /ws"]));
    expect(outcomes.find((o) => o.url.includes("rpc.leak.invalid"))?.outcome).toMatch(/^error/);
  } finally {
    await guard.close();
  }
});

test("through a browser proxy, WalletShield calls succeed (no targetAddressSpace)", async ({
  browser,
}) => {
  // Chromium refuses a fetch naming a targetAddressSpace once it is proxied
  // ("resource is in address space `unknown`"). The transport names none, so a
  // user whose browser proxies the WalletShield address (here: loopback forced
  // through the proxy) still reaches it.
  const guard = await guarded(browser, "<-loopback>");
  try {
    const page = await open(guard);
    expect((await bootZknet(page)).ok).toBe(true);
    const r = await call(page);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);
  } finally {
    await guard.close();
  }
});
