import {
  marked,
  startStubWalletShield,
  type StubWalletShield,
} from "../testing/stub-walletshield.js";
import { TransportError } from "./errors.js";
import { WalletShieldTransport } from "./walletshield.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const RPC = enc.encode('{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}');
const req = (network = "ethereum") => ({ network, body: RPC, contentType: "application/json" });

async function rejection(p: Promise<unknown>): Promise<TransportError> {
  const e = await p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(TransportError);
  return e as TransportError;
}

/** A fetch that fails like the browser does when it refuses before any reply. */
const failingFetch = (async () => {
  throw new TypeError("Failed to fetch");
}) as typeof fetch;

let stub: StubWalletShield;
beforeEach(async () => {
  stub = await startStubWalletShield();
});
afterEach(async () => {
  await stub.close();
});

describe("construction", () => {
  it("defaults to the conventional loopback address", () => {
    expect(new WalletShieldTransport().target).toBe("loopback");
  });

  it.each([
    "http://8.8.8.8:7070",
    "http://walletshield.example:7070",
    "ftp://127.0.0.1/",
    "http://u:p@127.0.0.1:7070",
    "http://127.0.0.1:7070/?a=1",
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => new WalletShieldTransport({ url })).toThrow(
      expect.objectContaining({ code: "unsupported", name: "TargetRefused" }),
    );
  });

  it("accepts a LAN peer", () => {
    expect(new WalletShieldTransport({ url: "http://192.168.1.20:7070" }).target).toBe("lan");
  });
});

describe("request", () => {
  it("posts the body to the network path and relays the upstream reply", async () => {
    const t = new WalletShieldTransport({ url: stub.url });
    const res = await t.request(req("ethereum/sepolia"));
    expect(res.status).toBe(200);
    expect(res.headers).toEqual([["content-type", "application/json"]]);
    expect(dec.decode(res.body)).toBe('{"jsonrpc":"2.0","id":1,"result":"0x10"}');
    const seen = stub.requests.at(-1)!;
    expect(seen.method).toBe("POST");
    expect(seen.path).toBe("/ethereum/sepolia");
    expect(seen.headers["content-type"]).toBe("application/json");
    expect(seen.body).toEqual(RPC);
  });

  it("posts a provider URL to /_/url in the ZKNet-URL header, not in the path", async () => {
    let target = "";
    stub.upstream = (t) => {
      target = t;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"result":"0x1"}',
      };
    };
    const res = await new WalletShieldTransport({ url: stub.url }).request({
      url: "https://rpc.example/v3/key",
      body: RPC,
      contentType: "application/json",
    });
    expect(res.status).toBe(200);
    expect(target).toBe("https://rpc.example/v3/key");
    const seen = stub.requests.at(-1)!;
    expect(`${seen.method} ${seen.path}`).toBe("POST /_/url");
    expect(seen.headers["zknet-url"]).toBe("https://rpc.example/v3/key");
    expect(seen.body).toEqual(RPC);
  });

  it("sends exactly the view it is given, not its whole buffer", async () => {
    const t = new WalletShieldTransport({ url: stub.url });
    const padded = new Uint8Array(RPC.length + 8);
    padded.set(RPC, 4);
    await t.request({ ...req(), body: padded.subarray(4, 4 + RPC.length) });
    expect(stub.requests.at(-1)!.body).toEqual(RPC);
  });

  it("passes an upstream non-200 through with allowlisted headers only", async () => {
    stub.upstream = () => ({
      status: 429,
      headers: { "content-type": "text/plain", "retry-after": "7", "x-upstream": "drop" },
      body: "slow down %d %s",
    });
    const res = await new WalletShieldTransport({ url: stub.url }).request(req());
    expect(res.status).toBe(429);
    expect(res.headers).toEqual([
      ["content-type", "text/plain"],
      ["retry-after", "7"],
    ]);
    expect(dec.decode(res.body)).toBe("slow down %d %s");
  });

  it("relays a provider redirect as the reply, unfollowed", async () => {
    stub.upstream = () => ({ status: 308, body: "" });
    expect((await new WalletShieldTransport({ url: stub.url }).request(req())).status).toBe(308);
  });

  it("refuses a reply the peer redirected, which WalletShield never does", async () => {
    stub.upstream = (target) =>
      target === "elsewhere"
        ? { status: 200, body: "{}" }
        : { status: 307, headers: { location: `${stub.url}/elsewhere` }, body: "" };
    const e = await rejection(new WalletShieldTransport({ url: stub.url }).request(req()));
    expect([e.code, e.name]).toEqual(["protocol-error", "UnexpectedReply"]);
  });

  it("treats an unmarked 502 as the upstream reply", async () => {
    stub.upstream = () => ({ status: 502, body: "bad gateway upstream" });
    const res = await new WalletShieldTransport({ url: stub.url }).request(req());
    expect(res.status).toBe(502);
  });

  it.each([
    ["mix-timeout", 504, "timeout", "MixTimeout"],
    ["exit-refused", 502, "permission-denied", "ExitRefused"],
    ["upstream-unreachable", 502, "network-error", "UpstreamUnreachable"],
    ["too-large", 413, "too-large", "TooLarge"],
    ["bad-reply", 502, "protocol-error", "BadReply"],
    ["exit-busy", 503, "queue-full", "ExitBusy"],
    ["provider-selection-off", 502, "permission-denied", "ExitRefused"],
    ["something-new", 500, "protocol-error", "UnexpectedReply"],
  ])("ZKNet-Error %s → %s", async (reason, status, code, name) => {
    stub.upstream = () => marked(reason, status, "diagnostic text");
    const e = await rejection(new WalletShieldTransport({ url: stub.url }).request(req()));
    expect(e.code).toBe(code);
    expect(e.name).toBe(name);
    expect(e.message).toBe(`${reason}: diagnostic text`);
  });

  it("branches on the marker, not the status", async () => {
    stub.upstream = () => ({ ...marked("mix-timeout", 200), status: 200 });
    expect(
      (await rejection(new WalletShieldTransport({ url: stub.url }).request(req()))).name,
    ).toBe("MixTimeout");
  });

  it("reports nothing listening as PeerUnreachable", async () => {
    const url = stub.url;
    await stub.close();
    const e = await rejection(new WalletShieldTransport({ url }).request(req()));
    expect([e.code, e.name]).toEqual(["network-error", "PeerUnreachable"]);
    stub = await startStubWalletShield();
  });

  it("applies its deadline", async () => {
    stub.upstream = () => "hang";
    const e = await rejection(
      new WalletShieldTransport({ url: stub.url, timeoutMs: 150 }).request(req()),
    );
    expect([e.code, e.name]).toEqual(["timeout", "Deadline"]);
  });

  it("honours the caller abort", async () => {
    stub.upstream = () => "hang";
    const ac = new AbortController();
    const p = new WalletShieldTransport({ url: stub.url }).request(req(), { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const e = await rejection(p);
    expect([e.code, e.name]).toEqual(["cancelled", "AbortError"]);
  });

  it("rejects at once on an already-aborted signal", async () => {
    const e = await rejection(
      new WalletShieldTransport({ url: stub.url }).request(req(), { signal: AbortSignal.abort() }),
    );
    expect(e.name).toBe("AbortError");
    expect(stub.requests).toHaveLength(0);
  });

  it("close() fails in-flight requests and the transport stays usable", async () => {
    stub.upstream = () => "hang";
    const t = new WalletShieldTransport({ url: stub.url });
    const p = t.request(req());
    setTimeout(() => void t.close(), 50);
    expect((await rejection(p)).name).toBe("Closed");
    stub.upstream = () => ({ status: 200, body: "{}" });
    expect((await t.request(req())).status).toBe(200);
  });

  it("names a browser refusal before any reply PeerUnreachable", async () => {
    const e = await rejection(
      new WalletShieldTransport({ url: stub.url, fetch: failingFetch }).request(req()),
    );
    expect([e.code, e.name]).toEqual(["network-error", "PeerUnreachable"]);
  });

  it("names no targetAddressSpace (Chromium refuses it through a proxy)", async () => {
    const inits: RequestInit[] = [];
    const spy = (async (url: string, init?: RequestInit) => {
      inits.push(init ?? {});
      return fetch(url, init);
    }) as typeof fetch;
    const t = new WalletShieldTransport({ url: stub.url, fetch: spy });
    await t.request(req());
    await t.probe({ depth: "exit" });
    expect(inits.length).toBeGreaterThan(0);
    for (const init of inits) expect(init).not.toHaveProperty("targetAddressSpace");
  });

  it("names a predicted mixed-content block for an http: LAN peer from a secure context", async () => {
    const t = new WalletShieldTransport({
      url: "http://192.168.1.20:7070",
      fetch: failingFetch,
      isSecureContext: true,
    });
    expect(t.mixedContentPredicted).toBe(true);
    const e = await rejection(t.request(req()));
    expect([e.code, e.name]).toEqual(["unsupported", "MixedContentBlocked"]);
  });

  it("predicts no mixed content for loopback or https", () => {
    expect(
      new WalletShieldTransport({ url: "http://127.0.0.1:7070", isSecureContext: true })
        .mixedContentPredicted,
    ).toBe(false);
    expect(
      new WalletShieldTransport({ url: "https://192.168.1.20:7070", isSecureContext: true })
        .mixedContentPredicted,
    ).toBe(false);
  });
});

describe("probe", () => {
  it("reaches the peer through its local health answer, without the mixnet", async () => {
    const r = await new WalletShieldTransport({ url: stub.url }).probe();
    expect(r).toMatchObject({ reach: "peer", peerVersion: "stub-0.0.0" });
    expect(stub.requests.map((q) => q.path)).toEqual(["/_/health"]);
  });

  it("reaches the exit when asked to", async () => {
    const r = await new WalletShieldTransport({ url: stub.url }).probe({ depth: "exit" });
    expect(r).toMatchObject({ reach: "exit", peerVersion: "stub-0.0.0" });
    expect(stub.requests.map((q) => `${q.method} ${q.path}`)).toEqual([
      "GET /_/health",
      "POST /_/probe/0",
    ]);
  });

  it("stops at the peer on a mix timeout", async () => {
    const t = new WalletShieldTransport({
      url: stub.url,
      fetch: routedFetch({ "/_/probe/0": marked("mix-timeout", 504) }),
    });
    const r = await t.probe({ depth: "exit" });
    expect(r.reach).toBe("peer");
    expect(r.error).toMatchObject({ code: "timeout", name: "MixTimeout" });
  });

  it("counts an exit-originated failure as the exit answering", async () => {
    const t = new WalletShieldTransport({
      url: stub.url,
      fetch: routedFetch({ "/_/probe/0": marked("bad-reply", 502) }),
    });
    expect((await t.probe({ depth: "exit" })).reach).toBe("exit");
  });

  it("reports nothing listening", async () => {
    const url = stub.url;
    await stub.close();
    const r = await new WalletShieldTransport({ url }).probe();
    expect(r.reach).toBe("none");
    expect(r.error).toMatchObject({ name: "PeerUnreachable" });
    stub = await startStubWalletShield();
  });

  it("tells a CORS rejection from nothing listening", async () => {
    const corsOnly = (async (_url: string, init?: RequestInit) => {
      if (init?.mode === "no-cors") return new Response(null, { status: 200 });
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const r = await new WalletShieldTransport({ url: stub.url, fetch: corsOnly }).probe();
    expect(r.reach).toBe("peer");
    expect(r.error).toMatchObject({ code: "permission-denied", name: "CorsRejected" });
  });

  it("never rejects", async () => {
    const r = await new WalletShieldTransport({ url: stub.url }).probe({
      signal: AbortSignal.abort(),
    });
    expect(r).toMatchObject({ reach: "none", error: { name: "AbortError" } });
  });

  /** The stub's fetch, except that the listed paths answer with a canned reply. */
  function routedFetch(
    routes: Record<
      string,
      { status: number; headers?: Record<string, string>; body: string | Uint8Array }
    >,
  ): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      const route = routes[new URL(url).pathname];
      if (route)
        return new Response(route.body as BodyInit, {
          status: route.status,
          headers: route.headers,
        });
      return fetch(url, init);
    }) as typeof fetch;
  }
});
