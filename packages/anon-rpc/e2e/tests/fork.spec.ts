// Fork tier (optional): the PROPOSED WorkerInit.network policy, with a
// harness built from an anon-rpc checkout (ANON_RPC_REPO) that has it. The
// page is served over https and made public with an address-space override,
// a CONTROL standing in for a page on the internet, so Local Network Access
// applies; the user's grants are seeded as persisted site settings. What is
// under test is the harness's frame delegation: the worker reaches only the
// address spaces its host's policy names.
//
// Without ANON_RPC_REPO, only the first test runs: it proves that nothing in
// this package depends on a checkout.

import { expect, test, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startStubWalletShield, type StubWalletShield } from "@zknet/anon-rpc-transport/testing";
import type { BootRequest } from "../page/api.js";
import { startChain, type Chain } from "../src/chain.js";
import {
  buildForkHarness,
  lanAddress,
  publicProfile,
  selfSigned,
  startLanStub,
  type ForkHarness,
  type LanStub,
} from "../src/fork.js";
import { bundlePage, servePage, type PageServer } from "../src/page.js";
import { ANON_RPC_DIR, E2E_DIR, WORKER_BUNDLE } from "../src/paths.js";

const REPO = process.env.ANON_RPC_REPO;
const RPC_BODY = '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}';

test("without ANON_RPC_REPO, nothing in this package depends on an anon-rpc checkout", () => {
  const manifest = JSON.parse(readFileSync(join(E2E_DIR, "package.json"), "utf8"));
  for (const spec of Object.values<string>(manifest.devDependencies)) {
    expect(spec).toMatch(/^(\d+\.\d+\.\d+|workspace:\*)$/); // exact versions or workspace links, no file:/link:/git
  }
  const lock = readFileSync(join(ANON_RPC_DIR, "../../pnpm-lock.yaml"), "utf8");
  const importer = lock.split("\n  packages/anon-rpc/e2e:\n")[1]?.split("\n\n")[0] ?? "";
  expect(importer).toContain(
    "'@anon-rpc/browser-harness':\n        specifier: 0.3.3\n        version: 0.3.3",
  );
  expect(importer).not.toMatch(/file:|link:\.\.\/\.\.\/\.\./);
  // Only this spec reads the variable; the default tiers never see it.
  const readers = [
    "project.json",
    "playwright.config.ts",
    ...["page", "src", "tests"].flatMap((d) =>
      readdirSync(join(E2E_DIR, d)).map((f) => `${d}/${f}`),
    ),
  ].filter((f) => readFileSync(join(E2E_DIR, f), "utf8").includes("env.ANON_RPC_REPO"));
  expect(readers).toEqual(["tests/fork.spec.ts"]);
});

test.describe("fork harness: network.policy", () => {
  test.skip(!REPO, "set ANON_RPC_REPO to an anon-rpc checkout with feat/worker-network-policy");

  let fork: ForkHarness;
  let chain: Chain;
  let site: PageServer;
  let loop: StubWalletShield;
  let lan: LanStub | undefined;
  let address: string;
  const lanIp = lanAddress();

  test.beforeAll(async () => {
    fork = buildForkHarness(REPO!);
    chain = await startChain();
    address = await chain.deploy(WORKER_BUNDLE);
    loop = await startStubWalletShield();
    if (lanIp) lan = await startLanStub(lanIp);
    site = await servePage(await bundlePage(fork), selfSigned());
  });

  test.afterAll(async () => {
    await site?.close();
    await loop?.close();
    await lan?.close();
    await chain?.stop();
  });

  async function open(grant = true): Promise<{ page: Page; close: () => Promise<void> }> {
    const profile = await publicProfile(site.origin, grant);
    const page = profile.context.pages()[0] ?? (await profile.context.newPage());
    await page.goto(`${site.origin}/`);
    await page.waitForFunction(() => window.e2e !== undefined);
    expect(await page.evaluate(() => window.e2e.harness)).toBe(fork.label);
    return { page, close: profile.close };
  }

  async function bootAndCall(page: Page, walletshield: string, network?: BootRequest["network"]) {
    const booted = await page.evaluate((req) => window.e2e.boot(req), {
      id: "w",
      address,
      rpcUrl: chain.rpcUrl,
      config: { walletshield },
      ...(network ? { network } : {}),
      readyTimeoutMs: 30_000,
    });
    expect(booted.error).toBeUndefined();
    const call = await page.evaluate((req) => window.e2e.fetch(req), {
      id: "w",
      url: `${walletshield}/ethereum`,
      body: RPC_BODY,
      timeoutMs: 20_000,
    });
    return { booted, call };
  }

  const posts = () => loop.requests.filter((q) => q.method === "POST").length;

  test("CONTROL: the overridden page is public, so without a grant even a delegated worker is refused", async () => {
    const { page, close } = await open(false);
    try {
      // The harness itself reads the chain and the resolver from the page; refused without a grant.
      const booted = await page.evaluate((req) => window.e2e.boot(req), {
        id: "w",
        address,
        rpcUrl: chain.rpcUrl,
        config: { walletshield: loop.url },
        network: { policy: { allow: ["loopback"] } },
        readyTimeoutMs: 15_000,
      });
      expect(booted.ok).toBe(false);
    } finally {
      await close();
    }
  });

  test('allow ["loopback"] reaches a loopback WalletShield', async () => {
    const { page, close } = await open();
    try {
      const before = posts();
      const { booted, call } = await bootAndCall(page, loop.url, {
        policy: { allow: ["loopback"] },
      });
      expect(booted.allow).toBe("loopback-network");
      expect(call.error).toBeUndefined();
      expect(call.status).toBe(200);
      expect(posts()).toBe(before + 1);
    } finally {
      await close();
    }
  });

  test("no policy: the same worker, page and grant are blocked", async () => {
    const { page, close } = await open();
    try {
      const before = posts();
      const { booted, call } = await bootAndCall(page, loop.url);
      expect(booted.allow).toBeNull();
      expect({ code: call.error?.code, name: call.error?.name }).toEqual({
        code: "network-error",
        name: "PeerUnreachable",
      });
      expect(posts()).toBe(before); // nothing reached WalletShield
    } finally {
      await close();
    }
  });

  test('allow ["loopback", "local"] reaches a WalletShield on an RFC 1918 address', async () => {
    test.skip(!lan, "this host has no RFC 1918 IPv4 address");
    const { page, close } = await open();
    try {
      const before = lan!.posts;
      const { booted, call } = await bootAndCall(page, lan!.url, {
        policy: { allow: ["loopback", "local"] },
      });
      expect(booted.allow).toBe("loopback-network; local-network; local-network-access");
      expect(call.error).toBeUndefined();
      expect(call.status).toBe(200);
      expect(lan!.posts).toBe(before + 1);
    } finally {
      await close();
    }
  });

  test('allow ["loopback"] does not reach the LAN: delegation is per address space', async () => {
    test.skip(!lan, "this host has no RFC 1918 IPv4 address");
    const { page, close } = await open();
    try {
      const before = lan!.posts;
      const { call } = await bootAndCall(page, lan!.url, { policy: { allow: ["loopback"] } });
      expect({ code: call.error?.code, name: call.error?.name }).toEqual({
        code: "network-error",
        name: "PeerUnreachable",
      });
      expect(lan!.posts).toBe(before);
    } finally {
      await close();
    }
  });
});
