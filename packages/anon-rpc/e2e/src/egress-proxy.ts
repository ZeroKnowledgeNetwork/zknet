// The egress check's two layers.
//
// The proxy: a guarded browser context sends every request through it except
// those to the exact allowed origins (bypassed by host:port, with
// `<-loopback>` so no other loopback port or `localhost` alias is exempt).
// That covers the page, the sandboxed harness frame and the worker alike:
// other loopback ports, aliases, LAN addresses, DNS names, public hosts, and
// the CONNECT tunnels of https and WebSockets. Each is recorded; loopback
// targets are forwarded and anything else refused without a DNS lookup, so a
// leaking worker never leaves the host.
//
// The browser layer: Playwright's request events, which include the worker's
// fetches inside the sandboxed frame, cover the allowed origins' traffic that
// goes direct. They do not include a worker's WebSockets, which is why no
// origin a WebSocket could use is left unproxied.
//
// Allowed origins go direct and are observed on the browser layer. Proxying
// them works too: the transport names no `targetAddressSpace`, which Chromium
// would refuse once proxied (tests/egress.spec.ts forces loopback through the
// proxy to keep it that way).

import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, isIPv4, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";

export interface EgressEvent {
  /** proxy layer: http, connect, upgrade; browser layer: browser. */
  kind: "http" | "connect" | "upgrade" | "browser";
  method: string;
  /** `http://host:port` for http and upgrade, `host:port` for connect. */
  origin: string;
  /** The full URL for http and upgrade requests. */
  url?: string;
  /** Whether the proxy forwarded it (loopback) or refused it; false on the browser layer. */
  forwarded: boolean;
}

export interface EgressProxy {
  /** For Playwright's `proxy.server`. */
  url: string;
  events: EgressEvent[];
  close(): Promise<void>;
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || (isIPv4(bare) && bare.startsWith("127."));
}

function authority(raw: string): { host: string; port: number } | undefined {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(raw);
  if (!m) return undefined;
  return { host: (m[1] ?? "").replace(/^\[|\]$/g, ""), port: Number(m[2]) };
}

function absolute(raw: string | undefined): URL | undefined {
  if (!raw || !/^https?:\/\//i.test(raw)) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

const portOf = (u: URL) => (u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port));
const originOf = (u: URL) => `${u.protocol}//${u.hostname}:${portOf(u)}`;

export async function startEgressProxy(): Promise<EgressProxy> {
  const events: EgressEvent[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    const url = absolute(req.url);
    if (!url) {
      res.writeHead(400).end("absolute-form requests only");
      return;
    }
    const forwarded = isLoopbackHost(url.hostname);
    events.push({
      kind: "http",
      method: req.method ?? "",
      origin: originOf(url),
      url: url.href,
      forwarded,
    });
    if (!forwarded) {
      res.writeHead(502, { "content-type": "text/plain" }).end("egress refused by the e2e proxy");
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = httpRequest(
      {
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: portOf(url),
        method: req.method,
        path: url.pathname + url.search,
        headers,
      },
      (up: IncomingMessage) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });

  // CONNECT: https and (proxied) WebSockets both tunnel this way.
  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    const target = authority(req.url ?? "");
    const forwarded = target !== undefined && isLoopbackHost(target.host);
    events.push({ kind: "connect", method: "CONNECT", origin: req.url ?? "", forwarded });
    if (!target || !forwarded) {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    const up = connect(target.port, target.host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    sockets.add(up);
    up.on("close", () => sockets.delete(up));
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });

  // A plain ws:// handshake sent in absolute form.
  server.on("upgrade", (req: IncomingMessage, client: Duplex) => {
    const url = absolute(req.url);
    events.push({
      kind: "upgrade",
      method: req.method ?? "",
      origin: url ? originOf(url) : (req.url ?? ""),
      ...(url ? { url: url.href } : {}),
      forwarded: false,
    });
    client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });

  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    events,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** Requests the browser layer records but that cannot leave the browser. */
const LOCAL_SCHEMES = /^(blob|data):/;

/** `http(s)://host:port` of a URL, with the default port spelled out. */
export function originOfUrl(raw: string): string {
  return originOf(new URL(raw));
}

/**
 * Every event outside `allowed` (http origins like http://127.0.0.1:PORT).
 * The bed never tunnels or upgrades, so any CONNECT or upgrade is one.
 */
export function violations(
  events: readonly EgressEvent[],
  allowed: readonly string[],
): EgressEvent[] {
  return events.filter((e) => {
    if (e.kind === "connect" || e.kind === "upgrade") return true;
    if (e.url !== undefined && LOCAL_SCHEMES.test(e.url)) return false;
    return !allowed.includes(e.origin);
  });
}
