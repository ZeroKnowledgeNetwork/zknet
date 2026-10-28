// A stub WalletShield for tests: a real local HTTP listener that speaks the
// reply contract (see ../lib/walletshield.ts), with no mixnet behind it.
//
// Each POST is answered by `upstream(target, body)`, where `target` is what
// the exit would fetch: the `[Networks]` key of `POST /<network>`, or the
// provider URL of `POST /_/url`. Tests swap it per case.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { UPSTREAM_HEADERS, URL_HEADER, USER_URL_PATH } from "../lib/walletshield.js";

export interface StubReply {
  status: number;
  headers?: Record<string, string>;
  body: string | Uint8Array;
}

export interface StubRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Uint8Array;
}

export interface StubWalletShield {
  url: string;
  /** Every request received, in order. */
  requests: StubRequest[];
  /**
   * Answers POSTs other than the exit probe. `target` is the network key, or
   * the provider URL for `POST /_/url`. Default: a JSON-RPC result for
   * `eth_blockNumber`.
   */
  upstream: (target: string, body: Uint8Array) => StubReply | Promise<StubReply> | "hang";
  close(): Promise<void>;
}

/** A `ZKNet-Error` reply, as WalletShield or the exit originates it. */
export function marked(reason: string, status: number, message = reason): StubReply {
  return {
    status,
    headers: { "content-type": "application/json", "zknet-error": reason },
    body: JSON.stringify({ error: { reason, message } }),
  };
}

export async function startStubWalletShield(version = "stub-0.0.0"): Promise<StubWalletShield> {
  const stub: StubWalletShield = {
    url: "",
    requests: [],
    upstream: () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","id":1,"result":"0x10"}',
    }),
    close: async () => {},
  };
  const open = new Set<ServerResponse>();

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = req.url ?? "/";
    stub.requests.push({
      method: req.method ?? "",
      path,
      headers: req.headers,
      body: new Uint8Array(Buffer.concat(chunks)),
    });

    res.setHeader("access-control-allow-origin", "*");
    // As WalletShield does (apps/walletshield/cors.go): a browser's CORS
    // preflight is answered locally, never treated as a request.
    if (
      req.method === "OPTIONS" &&
      req.headers.origin &&
      req.headers["access-control-request-method"]
    ) {
      res.setHeader("access-control-allow-methods", "GET, POST");
      const requested = req.headers["access-control-request-headers"];
      if (requested) res.setHeader("access-control-allow-headers", requested);
      res.setHeader("access-control-max-age", "600");
      res.writeHead(204).end();
      return;
    }
    // As WalletShield does: the failure marker plus every relayed upstream header, so a browser can read them.
    res.setHeader("access-control-expose-headers", ["ZKNet-Error", ...UPSTREAM_HEADERS].join(", "));
    let reply: StubReply | "hang";
    const providerURL = req.headers[URL_HEADER];
    if (req.method === "GET" && path === "/_/health") {
      reply = {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version }),
      };
    } else if (path.startsWith("/_/probe")) {
      reply = { status: 200, body: "" };
    } else if (path === USER_URL_PATH) {
      // As WalletShield does: the provider URL comes from the header, which is required.
      reply =
        typeof providerURL === "string" && providerURL !== ""
          ? await stub.upstream(providerURL, new Uint8Array(Buffer.concat(chunks)))
          : marked("exit-refused", 502, `POST ${USER_URL_PATH} needs a ZKNet-URL header`);
    } else {
      reply = await stub.upstream(path.slice(1), new Uint8Array(Buffer.concat(chunks)));
    }
    if (reply === "hang") {
      open.add(res);
      return;
    }
    res.writeHead(reply.status, reply.headers ?? {});
    res.end(reply.body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}
