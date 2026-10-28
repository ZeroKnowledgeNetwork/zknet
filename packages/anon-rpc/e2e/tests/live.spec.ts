// Live tier, for a human: the same host page and npm-pinned harness as the
// pinned tier, but the worker talks to a REAL WalletShield, which carries each
// call over a real ZKNet mixnet to an exit and its upstream RPC. Nothing here
// starts a mixnet or a WalletShield; start them first (see README § Live tier).
//
//   WALLETSHIELD_URL  the WalletShield listener (default http://127.0.0.1:7070)
//   LIVE_TIMEOUT_MS   the worker's per-call deadline (default 60000)
//   LIVE_RTT_PROBES   exit probes timed for the mix round trip (default 20)
//   LIVE_EXIT_BED     the dev mix's net directory: also run the refusals that
//                     need an https stub the exit can reach (src/exit-testbed.ts
//                     rewrites that exit's config and restarts its service node)

import { expect, test, type Page } from '@playwright/test';
import type { FetchResult } from '../page/api.js';
import { startChain, type Chain } from '../src/chain.js';
import { PRIVATE_HOST, startExitTestbed, type ExitTestbed } from '../src/exit-testbed.js';
import { bundlePage, pinnedHarness, servePage, type PageServer } from '../src/page.js';
import { WORKER_BUNDLE } from '../src/paths.js';

const WALLETSHIELD = process.env.WALLETSHIELD_URL ?? 'http://127.0.0.1:7070';
const TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS ?? 60_000);
const RTT_PROBES = Number(process.env.LIVE_RTT_PROBES ?? 20);
const EXIT_BED = process.env.LIVE_EXIT_BED;

// Per chain: the anon-rpc demo's prefilled public provider, and the exit's [Networks] key.
const CHAINS = [
  {
    chain: 'mainnet',
    provider: 'https://ethereum-rpc.publicnode.com',
    network: 'ethereum',
    chainId: '0x1',
  },
  {
    chain: 'sepolia',
    provider: 'https://ethereum-sepolia-rpc.publicnode.com',
    network: 'ethereum/sepolia',
    chainId: '0xaa36a7',
  },
];

let chain: Chain;
let site: PageServer;
let address: string;

const say = (line = '') => console.log(line);

test.beforeAll(async () => {
  say(`live tier: worker → WalletShield ${WALLETSHIELD} → mixnet → exit`);
  // WalletShield answers /_/health itself, without a mixnet round trip.
  try {
    const res = await fetch(`${WALLETSHIELD}/_/health`, { signal: AbortSignal.timeout(5_000) });
    say(`WalletShield /_/health: HTTP ${res.status} ${(await res.text()).trim()}`);
  } catch (e) {
    throw new Error(
      `WalletShield is not answering at ${WALLETSHIELD} (${String(e)}). Start it, or set WALLETSHIELD_URL.`,
    );
  }
  chain = await startChain(); // a local anvil for the specifier only; the RPC under test is behind the exit
  address = await chain.deploy(WORKER_BUNDLE);
  site = await servePage(await bundlePage(pinnedHarness()));
  say(
    `host page ${site.origin}/ (loopback: no Local Network Access prompt), specifier ${address} on ${chain.rpcUrl}`,
  );
});

test.afterAll(async () => {
  await site?.close();
  await chain?.stop();
});

async function bootWorker(page: Page): Promise<void> {
  await page.goto(`${site.origin}/`);
  await page.waitForFunction(() => window.e2e !== undefined);
  const booted = await page.evaluate((req) => window.e2e.boot(req), {
    id: 'w',
    address,
    rpcUrl: chain.rpcUrl,
    config: { walletshield: WALLETSHIELD, timeoutMs: TIMEOUT_MS },
    readyTimeoutMs: 30_000,
  });
  expect(booted.error).toBeUndefined();
}

function rpc(page: Page, url: string, method = 'eth_chainId'): Promise<FetchResult> {
  return page.evaluate((req) => window.e2e.fetch(req), {
    id: 'w',
    url,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
    timeoutMs: TIMEOUT_MS + 5_000,
  });
}

function report(label: string, r: FetchResult): void {
  say(
    r.ok
      ? `${label}: HTTP ${r.status} in ${Math.round(r.ms)} ms → ${r.bodyText}`
      : `${label}: ${r.error?.code} / ${r.error?.name} in ${Math.round(r.ms)} ms: ${r.error?.message}`,
  );
}

const result = (r: FetchResult) => (JSON.parse(r.bodyText ?? '{}') as { result?: unknown }).result;

/** The exit answered a probe: it answers as an upstream would, 200 with an empty body. */
const exitAnswered = (res: Response | undefined) =>
  res?.status === 200 && !res.headers.has('zknet-error');

/** The mix round trip, from WalletShield's exit probe: one mixnet round trip, the exit answers without an upstream. */
test('mix round-trip time', async () => {
  const ms: number[] = [];
  let failed = 0;
  for (let i = 0; i < RTT_PROBES; i++) {
    const t = performance.now();
    const res = await fetch(`${WALLETSHIELD}/_/probe/0`, {
      method: 'POST',
      body: '',
      signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined);
    if (exitAnswered(res)) ms.push(performance.now() - t);
    else failed++;
    await res?.arrayBuffer();
  }
  ms.sort((a, b) => a - b);
  const at = (q: number) =>
    Math.round(ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? NaN);
  say(
    `mix RTT over ${ms.length}/${RTT_PROBES} exit probes (${failed} failed): min ${at(0)} · p50 ${at(0.5)} · p90 ${at(0.9)} · max ${at(1)} ms`,
  );
  say(
    `budget: the client keeps a reply for the encoded round trip + 4.5 s (3 layers); the exit's upstream timeout is 3.5 s`,
  );
  expect(ms.length).toBeGreaterThan(0);
});

// Tripwire for the exit's upstream timeout (rpc_proxy/limits.go): an
// exit-side delay just under it must still come back. The katzenpost client
// drops a reply later than the encoded round trip + 4.5 s (3 layers); if
// UpstreamTimeout outgrows that window, or the window shrinks, this fails.
const UPSTREAM_TIMEOUT_MS = 3_500;
const JUST_UNDER_MS = 3_000;

test('an exit-side delay just under the upstream timeout still comes back', async () => {
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const res = await fetch(`${WALLETSHIELD}/_/probe/${JUST_UNDER_MS / 1000}`, {
      method: 'POST',
      body: '',
      signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined);
    await res?.arrayBuffer();
    const ms = Math.round(performance.now() - t);
    say(
      `exit probe delayed ${JUST_UNDER_MS} ms (upstream timeout ${UPSTREAM_TIMEOUT_MS} ms): ${res?.headers.get('zknet-error') ?? res?.status} in ${ms} ms`,
    );
    expect(exitAnswered(res), `a reply delayed ${JUST_UNDER_MS} ms at the exit was lost`).toBe(
      true,
    );
  }
});

for (const { chain: name, provider, network, chainId } of CHAINS) {
  test(`${name}: the demo's provider URL and WalletShield's network URL both answer`, async ({
    page,
  }) => {
    await bootWorker(page);
    const viaProvider = await rpc(page, provider);
    report(`${name} provider ${provider}`, viaProvider);
    const viaNetwork = await rpc(page, `${WALLETSHIELD}/${network}`);
    report(`${name} WalletShield /${network}`, viaNetwork);
    expect([viaProvider.status, result(viaProvider)]).toEqual([200, chainId]);
    expect([viaNetwork.status, result(viaNetwork)]).toEqual([200, chainId]);
  });
}

test('private provider addresses are refused: literals by the worker, names by the exit after DNS', async ({
  page,
}) => {
  await bootWorker(page);
  for (const url of ['https://10.0.0.1/', 'https://127.0.0.1:8545/']) {
    const r = await rpc(page, url);
    report(`refusal ${url}`, r);
    expect({ url, code: r.error?.code, name: r.error?.name }).toEqual({
      url,
      code: 'unsupported',
      name: 'UnsupportedRequest',
    });
  }
  // A public name that resolves to loopback: only the exit can tell.
  for (const url of ['https://localtest.me/']) {
    const r = await rpc(page, url);
    report(`refusal ${url}`, r);
    expect({ url, code: r.error?.code, name: r.error?.name }).toEqual({
      url,
      code: 'permission-denied',
      name: 'ExitRefused',
    });
  }
});

test.describe('against an https stub the exit can reach', () => {
  test.skip(!EXIT_BED, 'set LIVE_EXIT_BED to the dev mix net directory');
  let bed: ExitTestbed;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    bed = await startExitTestbed(EXIT_BED);
    say(`exit test bed: stub at ${bed.origin}; servicenode1 restarted with it allowed`);
    // Wait for the restarted exit to answer probes again.
    const until = Date.now() + 180_000;
    for (;;) {
      const res = await fetch(`${WALLETSHIELD}/_/probe/0`, {
        method: 'POST',
        body: '',
        signal: AbortSignal.timeout(25_000),
      }).catch(() => undefined);
      if (exitAnswered(res)) break;
      if (Date.now() > until) throw new Error('the exit did not come back after its restart');
      await new Promise((r) => setTimeout(r, 2_000));
    }
  });

  test.afterAll(async () => {
    await bed?.close();
  });

  test('the allowed stub answers, so the refusals below are the policy and limits at work', async ({
    page,
  }) => {
    await bootWorker(page);
    const r = await rpc(page, `${bed.origin}/ok`);
    report('stub /ok', r);
    expect([r.status, result(r)]).toEqual([200, '0xstub']);
  });

  test('a name that resolves to an RFC 1918 address the bed does not allow is refused after DNS', async ({
    page,
  }) => {
    await bootWorker(page);
    const r = await rpc(page, `https://${PRIVATE_HOST}/`);
    report(`refusal ${PRIVATE_HOST}`, r);
    expect({ code: r.error?.code, name: r.error?.name }).toEqual({
      code: 'permission-denied',
      name: 'ExitRefused',
    });
  });

  test('a provider answering just under the upstream timeout is relayed', async ({ page }) => {
    await bootWorker(page);
    const r = await rpc(page, `${bed.origin}/delay/${JUST_UNDER_MS}`);
    report(`stub /delay/${JUST_UNDER_MS}`, r);
    expect([r.status, result(r)]).toEqual([200, '0xdelay']);
  });

  test('a hung provider fails as the upstream, not as a mix timeout', async ({ page }) => {
    await bootWorker(page);
    const r = await rpc(page, `${bed.origin}/slow`);
    report('stub /slow', r);
    expect({ code: r.error?.code, name: r.error?.name }).toEqual({
      code: 'network-error',
      name: 'UpstreamUnreachable',
    });
    expect(r.ms).toBeLessThan(15_000); // WalletShield's mix timeout is 20 s
  });

  test('an oversized reply is too large', async ({ page }) => {
    await bootWorker(page);
    const r = await rpc(page, `${bed.origin}/big`);
    report('stub /big', r);
    expect({ code: r.error?.code, name: r.error?.name }).toEqual({
      code: 'too-large',
      name: 'TooLarge',
    });
  });

  test('a redirect to a private address is relayed, never followed', async ({ page }) => {
    await bootWorker(page);
    const r = await rpc(page, `${bed.origin}/redirect-private`);
    report('stub /redirect-private', r);
    expect(r.status).toBe(307);
    expect(r.headers?.some(([k]) => k === 'location')).toBe(false);
  });
});
