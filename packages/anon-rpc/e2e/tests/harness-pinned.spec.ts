// Harness-pinned tier: the ZKNet worker the way a wallet loads it, under the
// npm-published reference harness at an exact version. A WorkerSpecifier on
// anvil pins the real worker bundle; the harness reads it, fetches the bytes
// from the keccak resolver, checks the hash and boots the worker, which talks
// to a stub WalletShield. The page is served from loopback, which Local
// Network Access does not gate, so the published harness needs no delegation.

import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  marked,
  startStubWalletShield,
  type StubWalletShield,
} from '@zknet/anon-rpc-transport/testing';
import type { BootResult, FetchResult, LogLine } from '../page/api.js';
import { freePort, startChain, type Chain } from '../src/chain.js';
import {
  bundlePage,
  pinnedHarness,
  servePage,
  type PageBundle,
  type PageServer,
} from '../src/page.js';
import { E2E_DIR, WORKER_BUNDLE } from '../src/paths.js';

const RPC_BODY = '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}';

let chain: Chain;
let stub: StubWalletShield;
let bundle: PageBundle;
let site: PageServer;
let tamper: Server;
let address: string;
let tamperedAddress: string;

test.beforeAll(async () => {
  if (!existsSync(WORKER_BUNDLE)) {
    throw new Error(
      `no worker bundle at ${WORKER_BUNDLE}: run nx run @zknet/anon-rpc-worker:build`,
    );
  }
  chain = await startChain();
  address = await chain.deploy(WORKER_BUNDLE);

  // A resolver serving the bundle with one byte changed, for a specifier that pins the real hash.
  const bytes = readFileSync(WORKER_BUNDLE);
  const tampered = Buffer.concat([
    bytes.subarray(0, -1),
    Buffer.from([bytes[bytes.length - 1]! ^ 1]),
  ]);
  tamper = createServer((_req, res) => {
    res
      .writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' })
      .end(tampered);
  });
  await new Promise<void>((r) => tamper.listen(0, '127.0.0.1', () => r()));
  const tamperUrl = `http://127.0.0.1:${(tamper.address() as AddressInfo).port}/zknet-anon-rpc-worker.js`;
  tamperedAddress = await chain.deploy(WORKER_BUNDLE, { resolvers: [tamperUrl], unchecked: true });

  stub = await startStubWalletShield();
  bundle = await bundlePage(pinnedHarness());
  site = await servePage(bundle);
});

test.afterAll(async () => {
  await site?.close();
  await stub?.close();
  await new Promise<void>((r) => (tamper ? tamper.close(() => r()) : r()));
  await chain?.stop();
});

test.beforeEach(() => {
  stub.requests.length = 0;
  stub.upstream = () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"jsonrpc":"2.0","id":1,"result":"0x10"}',
  });
});

async function open(page: Page): Promise<void> {
  await page.goto(`${site.origin}/`);
  await page.waitForFunction(() => window.e2e !== undefined);
}

function boot(page: Page, config: unknown, at = address): Promise<BootResult> {
  return page.evaluate((req) => window.e2e.boot(req), {
    id: 'w',
    address: at,
    rpcUrl: chain.rpcUrl,
    config,
    readyTimeoutMs: 30_000,
  });
}

/** One JSON-RPC call; by default to WalletShield's own URL for the mainnet key. */
function rpc(page: Page, url = `${stub.url}/ethereum`, method = 'POST'): Promise<FetchResult> {
  return page.evaluate((req) => window.e2e.fetch(req), {
    id: 'w',
    url,
    method,
    body: method === 'GET' ? undefined : RPC_BODY,
    timeoutMs: 20_000,
  });
}

// Per chain: the demo's prefilled public provider and WalletShield's network key.
const CHAINS = [
  { chain: 'mainnet', provider: 'https://ethereum-rpc.publicnode.com', network: 'ethereum' },
  {
    chain: 'sepolia',
    provider: 'https://ethereum-sepolia-rpc.publicnode.com',
    network: 'ethereum/sepolia',
  },
];

const header = (r: FetchResult, name: string) => r.headers?.find(([k]) => k === name)?.[1];

test('the page runs the npm-pinned harness, exactly as published', async ({ page }) => {
  const pinned = pinnedHarness();
  const manifest = JSON.parse(readFileSync(join(E2E_DIR, 'package.json'), 'utf8'));
  expect(manifest.devDependencies['@anon-rpc/browser-harness']).toBe(pinned.version); // an exact pin, no range
  expect(pinned.version).toBe('0.3.3');
  expect(bundle.harnessInputs.length).toBeGreaterThan(0);
  for (const input of bundle.harnessInputs) {
    expect(input).toMatch(
      /node_modules\/(\.pnpm\/@anon-rpc\+browser-harness@0\.3\.3\/node_modules\/)?@anon-rpc\/browser-harness\//,
    );
  }
  await open(page);
  expect(await page.evaluate(() => window.e2e.harness)).toBe('npm:@anon-rpc/browser-harness@0.3.3');
});

test('boots the real worker bundle by specifier, in the sandbox', async ({ page }) => {
  await open(page);
  const booted = await boot(page, { walletshield: stub.url });
  expect(booted.error).toBeUndefined();
  expect(booted.ok).toBe(true);
  expect(booted.sandbox).toBe('allow-scripts');
  expect(booted.allow).toBeNull(); // the published harness delegates nothing
});

for (const { chain: name, provider, network } of CHAINS) {
  test(`${name}: a provider URL reaches WalletShield as POST /_/url with ZKNet-URL`, async ({
    page,
  }) => {
    await open(page);
    expect((await boot(page, { walletshield: stub.url })).ok).toBe(true);
    const r = await rpc(page, provider);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);
    expect(JSON.parse(r.bodyText ?? '')).toEqual({ jsonrpc: '2.0', id: 1, result: '0x10' });
    const posts = stub.requests.filter((q) => q.method === 'POST');
    // The worker forwards the URL as parsed: the bare origin gains its "/" path.
    expect(posts.map((q) => [q.path, q.headers['zknet-url']])).toEqual([
      ['/_/url', new URL(provider).href],
    ]);
    expect(Buffer.from(posts[0]!.body).toString()).toBe(RPC_BODY);
  });

  test(`${name}: WalletShield's own URL reaches it as POST /${network}`, async ({ page }) => {
    await open(page);
    expect((await boot(page, { walletshield: stub.url })).ok).toBe(true);
    const r = await rpc(page, `${stub.url}/${network}`);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);
    const posts = stub.requests.filter((q) => q.method === 'POST');
    expect(posts.map((q) => [q.path, q.headers['zknet-url']])).toEqual([
      [`/${network}`, undefined],
    ]);
  });
}

test('the worker refuses what it does not serve, before WalletShield sees it', async ({ page }) => {
  await open(page);
  expect((await boot(page, { walletshield: stub.url })).ok).toBe(true);
  const port = new URL(stub.url).port;
  const refused: [url: string, method?: string][] = [
    ['http://ethereum-rpc.publicnode.com'], // a plain-http provider
    [`http://localhost:${port}/ethereum`], // local, but not the configured WalletShield origin
    [`${stub.url}/_/url`], // WalletShield's own namespace, not a network key
    ['https://ethereum-rpc.publicnode.com', 'GET'],
  ];
  for (const [url, method] of refused) {
    const r = await rpc(page, url, method);
    expect({ url, method, code: r.error?.code, name: r.error?.name }).toEqual({
      url,
      method,
      code: 'unsupported',
      name: 'UnsupportedRequest',
    });
  }
  expect(stub.requests.filter((q) => q.method === 'POST')).toEqual([]);
});

test('an upstream 429 reaches the host as a 429 with retry-after', async ({ page }) => {
  stub.upstream = () => ({
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '7' },
    body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"rate limited"}}',
  });
  await open(page);
  expect((await boot(page, { walletshield: stub.url })).ok).toBe(true);
  const r = await rpc(page);
  expect(r.error).toBeUndefined();
  expect(r.status).toBe(429);
  expect(header(r, 'retry-after')).toBe('7');
  expect(header(r, 'content-type')).toBe('application/json');
});

// WalletShield's status per reason (apps/walletshield) and the worker's code table.
const REASONS: [reason: string, status: number, code: string, name: string][] = [
  ['mix-timeout', 504, 'timeout', 'MixTimeout'],
  ['exit-refused', 502, 'permission-denied', 'ExitRefused'],
  ['upstream-unreachable', 502, 'network-error', 'UpstreamUnreachable'],
  ['too-large', 413, 'too-large', 'TooLarge'],
  ['bad-reply', 502, 'protocol-error', 'BadReply'],
  ['exit-busy', 503, 'queue-full', 'ExitBusy'],
  ['provider-selection-off', 502, 'permission-denied', 'ExitRefused'],
  ['some-future-reason', 502, 'protocol-error', 'UnexpectedReply'],
];

test('every ZKNet-Error reason reaches the host as its code and name', async ({ page }) => {
  await open(page);
  expect((await boot(page, { walletshield: stub.url })).ok).toBe(true);
  for (const [reason, status, code, name] of REASONS) {
    stub.upstream = () => marked(reason, status);
    const r = await rpc(page);
    expect(r.ok, reason).toBe(false);
    expect({ reason, code: r.error?.code, name: r.error?.name }).toEqual({ reason, code, name });
  }
});

test('with no WalletShield listening, a call fails as PeerUnreachable', async ({ page }) => {
  const closed = await freePort();
  await open(page);
  // Not a signalFailed: the worker becomes ready, since WalletShield may start later.
  expect((await boot(page, { walletshield: `http://127.0.0.1:${closed}` })).ok).toBe(true);
  const r = await rpc(page, `http://127.0.0.1:${closed}/ethereum`);
  expect(r.ok).toBe(false);
  expect({ code: r.error?.code, name: r.error?.name }).toEqual({
    code: 'network-error',
    name: 'PeerUnreachable',
  });
});

test('bytes that do not hash to workerHash() are refused before anything runs', async ({
  page,
}) => {
  await open(page);
  const booted = await boot(page, { walletshield: stub.url }, tamperedAddress);
  expect(booted.ok).toBe(false);
  expect(booted.error?.message).toMatch(/no resolver yielded bytes matching workerHash/);
  expect(booted.error?.message).toMatch(/hash mismatch/);
  expect(stub.requests).toEqual([]); // the worker never ran, so it never probed WalletShield
});

test("the worker's logs arrive at the host", async ({ page }) => {
  await open(page);
  expect((await boot(page, { walletshield: stub.url, logLevel: 'debug' })).ok).toBe(true);
  expect((await rpc(page)).status).toBe(200);
  const lines: LogLine[] = await page.evaluate(() => window.e2e.logs('w', 50, 1_000));
  const events = lines.filter((l) => l.args[0] === 'zknet-worker').map((l) => l.args[1]);
  expect(events).toEqual(
    expect.arrayContaining(['boot.start', 'boot.config', 'ready', 'probe', 'call.done']),
  );
  // The log contract: no WalletShield address, URL or body in any entry.
  const text = JSON.stringify(lines);
  expect(text).not.toContain(stub.url);
  expect(text).not.toContain('eth_blockNumber');
});
