import {
  marked,
  startStubWalletShield,
  type StubWalletShield,
} from '@zknet/anon-rpc-transport/testing';
import { runWorker } from './core.js';
import { MAX_REQUEST_BODY_BYTES, MAX_URL_LENGTH } from './limits.js';
import type {
  AnonFetchResponse,
  AnonRequestInit,
  AnonRpcWorkerApi,
  IncomingCall,
  LogArg,
} from './spec-types.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const RPC = '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}';

/** A minimal in-process harness: queued calls, recorded signals and log entries. */
function fakeHarness(config: unknown) {
  const queue: IncomingCall[] = [];
  const waiters: ((c: IncomingCall) => void)[] = [];
  const logs: { level: string; args: LogArg[] }[] = [];
  const state = {
    ready: false,
    failed: undefined as { code?: string; message?: string } | undefined,
  };
  const log =
    (level: string) =>
    (...args: LogArg[]) =>
      void logs.push({ level, args });
  const api: AnonRpcWorkerApi = {
    signalReady: () => void (state.ready = true),
    signalFailed: (reason) => void (state.failed = reason),
    acceptCall: () => {
      const next = queue.shift();
      return next ? Promise.resolve(next) : new Promise((resolve) => waiters.push(resolve));
    },
    config,
    kps: undefined as never,
    storage: undefined as never,
    log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
  };
  const push = (call: IncomingCall) => {
    const w = waiters.shift();
    if (w) w(call);
    else queue.push(call);
  };
  /** Issue a fetch call; resolves with the response or rejects with the error the host would see. */
  const fetchCall = (url: string, requestInit?: AnonRequestInit) =>
    new Promise<AnonFetchResponse>((resolve, reject) => {
      push({
        kind: 'fetch',
        url,
        requestInit,
        respond: (r) => void Promise.resolve(r).then(resolve, reject),
      });
    });
  const events = () => logs.map((l) => `${l.level} ${String(l.args[1])}`);
  return { api, state, logs, events, fetchCall, push };
}

const post = (
  body: string | Uint8Array | ReadableStream<Uint8Array> = RPC,
  extra: AnonRequestInit = {},
): AnonRequestInit => ({
  method: 'POST',
  headers: [['content-type', 'application/json']],
  body: typeof body === 'string' ? enc.encode(body) : body,
  ...extra,
});

async function settle<T>(
  p: Promise<T>,
): Promise<
  { ok: true; value: T } | { ok: false; error: { name: string; code: string; message: string } }
> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error: error as { name: string; code: string; message: string } };
  }
}

let stub: StubWalletShield;
beforeEach(async () => {
  stub = await startStubWalletShield('ws-test-1');
});
afterEach(async () => {
  await stub.close();
});

function boot(config: Record<string, unknown> | undefined = {}) {
  const h = fakeHarness(config === undefined ? undefined : { walletshield: stub.url, ...config });
  void runWorker(h.api, { version: '0.0.1-test' });
  return h;
}

describe('boot', () => {
  it('signals ready and logs its boot sequence without the peer address', async () => {
    const h = boot();
    await vi.waitFor(() => expect(h.events()).toContain('info probe'));
    expect(h.state.ready).toBe(true);
    expect(h.events().slice(0, 3)).toEqual(['info boot.start', 'info boot.config', 'info ready']);
    expect(h.logs[1].args[2]).toEqual({
      peer: 'walletshield',
      target: 'loopback',
      timeoutMs: 30000,
    });
    expect(h.logs.find((l) => l.args[1] === 'probe')!.args[2]).toMatchObject({
      reach: 'peer',
      version: 'ws-test-1',
    });
    expect(JSON.stringify(h.logs)).not.toContain(stub.url.split('//')[1]);
  });

  it('becomes ready even when WalletShield is down', async () => {
    const url = stub.url;
    await stub.close();
    const h = fakeHarness({ walletshield: url });
    void runWorker(h.api, { version: 't' });
    await vi.waitFor(() => expect(h.events()).toContain('warn probe'));
    expect(h.state).toMatchObject({ ready: true, failed: undefined });
    stub = await startStubWalletShield();
  });

  it.each([
    [{ walletshield: 'http://8.8.8.8:7070' }, /loopback or local-network/],
    [{ walletshield: 'https://rpc.example.org' }, /loopback or local-network/],
    [{ network: 'ethereum' }, /unknown config key "network"/],
    [{ timeoutMs: 0 }, /timeoutMs/],
    [{ logLevel: 'trace' }, /logLevel/],
    [{ surprise: true }, /unknown config key "surprise"/],
  ])('fails permanently on bad config %j', async (config, message) => {
    const h = fakeHarness(config);
    await runWorker(h.api, { version: 't' });
    expect(h.state.ready).toBe(false);
    expect(h.state.failed?.code).toBe('bad-config');
    expect(h.state.failed?.message).toMatch(message);
  });

  it('runs on defaults when the host passes no config', async () => {
    const h = fakeHarness(undefined);
    void runWorker(h.api, { version: 't' });
    await vi.waitFor(() => expect(h.state.ready).toBe(true));
    expect(h.logs[1].args[2]).toMatchObject({ target: 'loopback' });
  });
});

const PROVIDER = 'https://rpc.example/v3/key';

describe('fetch calls', () => {
  /** WalletShield's own URL for a network key: the nominated URL. */
  const ws = (path: string) => `${stub.url}${path}`;

  it('relays a WalletShield network URL to that [Networks] key and the reply back', async () => {
    const h = boot();
    const res = await h.fetchCall(ws('/ethereum/sepolia'), post());
    expect(res.status).toBe(200);
    expect(res.headers).toEqual([['content-type', 'application/json']]);
    expect(dec.decode(res.body as Uint8Array)).toBe('{"jsonrpc":"2.0","id":1,"result":"0x10"}');
    const seen = stub.requests.find((r) => r.method === 'POST')!;
    expect(seen.path).toBe('/ethereum/sepolia');
    expect(seen.headers['zknet-url']).toBeUndefined();
    expect(dec.decode(seen.body)).toBe(RPC);
  });

  it('relays a provider URL to /_/url, in the ZKNet-URL header, and keeps it out of the logs', async () => {
    let target = '';
    stub.upstream = (t) => {
      target = t;
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"result":"0x1"}',
      };
    };
    const h = boot();
    const res = await h.fetchCall(`${PROVIDER}?a=1`, post());
    expect(res.status).toBe(200);
    expect(target).toBe(`${PROVIDER}?a=1`);
    expect(stub.requests.find((r) => r.method === 'POST')!.path).toBe('/_/url');
    await vi.waitFor(() => expect(h.events()).toContain('info probe'));
    expect(JSON.stringify(h.logs)).not.toContain('rpc.example');
  });

  it('buffers a streaming body', async () => {
    const h = boot();
    const bytes = enc.encode(RPC);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.subarray(0, 10));
        c.enqueue(bytes.subarray(10));
        c.close();
      },
    });
    await h.fetchCall(ws('/ethereum'), post(stream));
    expect(dec.decode(stub.requests.find((r) => r.method === 'POST')!.body)).toBe(RPC);
  });

  it('relays an upstream non-200 truthfully', async () => {
    stub.upstream = () => ({
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '3' },
      body: '{"error":"rate"}',
    });
    const h = boot();
    const res = await h.fetchCall(PROVIDER, post());
    expect(res.status).toBe(429);
    expect(res.headers).toContainEqual(['retry-after', '3']);
  });

  it('returns a relayed redirect as it came, and as a network error under redirect: error', async () => {
    stub.upstream = () => ({ status: 308, body: '' });
    const h = boot();
    expect((await h.fetchCall(PROVIDER, post())).status).toBe(308);
    expect((await h.fetchCall(PROVIDER, post(RPC, { redirect: 'manual' }))).status).toBe(308);
    const r = await settle(h.fetchCall(PROVIDER, post(RPC, { redirect: 'error' })));
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'network-error', name: 'RedirectRefused' },
    });
  });

  it.each([
    ['/ethereum', 'a relative URL'],
    ['/rpc', 'a relative URL'],
    ['http://rpc.example/', 'a plain-http provider'],
    ['https://u:p@rpc.example/', 'credentials'],
    ['https://rpc.example/#x', 'a fragment'],
    ['http://localhost:7070/ethereum', 'a local URL that is not the configured WalletShield'],
    ['http://192.168.1.20:7070/ethereum', 'a LAN URL that is not the configured WalletShield'],
  ])('refuses %s (%s)', async (url) => {
    const h = boot();
    const r = await settle(h.fetchCall(url, post()));
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'unsupported', name: 'UnsupportedRequest' },
    });
    expect(h.logs.find((l) => l.args[1] === 'call.refused')!.args[2]).toMatchObject({
      reason: 'url',
    });
    expect(stub.requests.filter((q) => q.method === 'POST')).toHaveLength(0);
  });

  it.each(['/', '/_/url', '/_/probe/0', '/ethereum/', '/ethereum?x=1', '/.x'])(
    'refuses the WalletShield path %s',
    async (path) => {
      const h = boot();
      const r = await settle(h.fetchCall(ws(path), post()));
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'unsupported', name: 'UnsupportedRequest' },
      });
      expect(stub.requests.filter((q) => q.method === 'POST')).toHaveLength(0);
    },
  );

  it('refuses GET', async () => {
    const h = boot();
    const r = await settle(h.fetchCall(PROVIDER));
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'unsupported', name: 'UnsupportedRequest' },
    });
    expect(h.logs.find((l) => l.args[1] === 'call.refused')!.args[2]).toMatchObject({
      reason: 'method',
    });
    expect(stub.requests.filter((q) => q.method === 'POST')).toHaveLength(0);
  });

  it('refuses a body or URL past its limit before sending', async () => {
    const h = boot();
    const big = new Uint8Array(MAX_REQUEST_BODY_BYTES + 1);
    expect(await settle(h.fetchCall(PROVIDER, post(big)))).toMatchObject({
      ok: false,
      error: { code: 'too-large', name: 'TooLarge' },
    });
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(64 * 1024));
      },
    });
    expect(await settle(h.fetchCall(PROVIDER, post(stream)))).toMatchObject({
      ok: false,
      error: { code: 'too-large', name: 'TooLarge' },
    });
    const long = `${PROVIDER}/${'a'.repeat(MAX_URL_LENGTH)}`;
    expect(await settle(h.fetchCall(long, post()))).toMatchObject({
      ok: false,
      error: { code: 'too-large', name: 'TooLarge' },
    });
    expect(stub.requests.filter((q) => q.method === 'POST')).toHaveLength(0);
  });

  it.each([
    ['mix-timeout', 504, 'timeout', 'MixTimeout'],
    ['exit-busy', 503, 'queue-full', 'ExitBusy'],
    ['provider-selection-off', 502, 'permission-denied', 'ExitRefused'],
  ])(
    'rejects ZKNet-Error %s with its code and name, and logs it without the method',
    async (reason, status, code, name) => {
      stub.upstream = () => marked(reason, status);
      const h = boot();
      const r = await settle(h.fetchCall(PROVIDER, post()));
      expect(r).toMatchObject({ ok: false, error: { code, name } });
      expect(h.logs.find((l) => l.args[1] === 'call.failed')!.args[2]).toMatchObject({
        seq: 1,
        route: 'url',
        code,
        name,
      });
      expect(JSON.stringify(h.logs)).not.toContain('eth_blockNumber');
    },
  );

  it('answers an abort with AbortError / cancelled', async () => {
    stub.upstream = () => 'hang';
    const h = boot();
    const ac = new AbortController();
    const p = settle(h.fetchCall(PROVIDER, post(RPC, { signal: ac.signal })));
    setTimeout(() => ac.abort(), 50);
    expect(await p).toMatchObject({ ok: false, error: { code: 'cancelled', name: 'AbortError' } });
  });

  it('keeps serving after a failed call, and serves calls concurrently', async () => {
    let n = 0;
    stub.upstream = () =>
      ++n === 1 ? marked('exit-refused', 502) : { status: 200, body: `{"n":${n}}` };
    const h = boot();
    const [a, b, c] = await Promise.all([
      settle(h.fetchCall(PROVIDER, post())),
      settle(h.fetchCall(ws('/ethereum'), post())),
      settle(h.fetchCall(PROVIDER, post())),
    ]);
    expect([a.ok, b.ok, c.ok].filter(Boolean)).toHaveLength(2);
  });

  it('probes after a network failure to label it', async () => {
    const h = boot();
    await vi.waitFor(() => expect(h.events()).toContain('info probe'));
    await stub.close();
    const r = await settle(h.fetchCall(PROVIDER, post()));
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'network-error', name: 'PeerUnreachable' },
    });
    await vi.waitFor(() => expect(h.events()).toContain('warn probe'));
    expect(h.logs.find((l) => l.level === 'warn' && l.args[1] === 'probe')!.args[2]).toMatchObject({
      reach: 'none',
      name: 'PeerUnreachable',
    });
    stub = await startStubWalletShield();
  });

  it('ignores call kinds it does not know and keeps serving', async () => {
    const h = boot();
    h.push({ kind: 'telepathy' } as unknown as IncomingCall);
    expect((await h.fetchCall(PROVIDER, post())).status).toBe(200);
    expect(h.events()).not.toContain('error accept.failed');
  });
});
