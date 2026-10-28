// KpclientdTransport: the next path. A Rust→wasm Katzenpost thin client
// talking to a local `kpclientd` over WebSocket: 4-byte big-endian length +
// CBOR `thin.Request`/`thin.Response` frames, a connection-status event and a
// PKI document on connect, and an optional 16-byte session token that resumes
// the same AppID (and its queued replies) across reconnects.
//
// The request it sends is the same one WalletShield sends: the inner request,
// compressed, CBOR-wrapped as `rpc_proxy.Request`, addressed to the
// `rpc_proxy` service from the PKI document. So it implements the same
// ExitRequest → ExitResponse contract. The inner request is built afresh from
// method, path, Content-Type and body, never the caller's own request; its
// contract, and the exit's refusal of anything else, is documented in
// packages/opt/server_plugins/cbor_plugins/rpc_proxy/request.go.
//
// STUB — this session ships the signature only.

import type {
  ExitRequest,
  ExitResponse,
  ProbeOptions,
  ProbeResult,
  RequestOptions,
  Transport,
} from "./types.js";

/** Where the session token persists; the worker passes `anonRpcWorker.storage`. */
export interface SessionStore {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
}

export interface KpclientdOptions {
  /** kpclientd's WebSocket listener, e.g. `ws://127.0.0.1:<port>/`. Same loopback/LAN rule as WalletShield. */
  url: string;
  /** Persists the session token so a reload resumes rather than loses queued replies. */
  session?: SessionStore;
  /** Test seam; the ambient `WebSocket` otherwise. */
  WebSocket?: typeof WebSocket;
}

export class KpclientdTransport implements Transport {
  readonly peer = "kpclientd" as const;

  constructor(_opts: KpclientdOptions) {
    throw new Error("not implemented");
  }

  request(_req: ExitRequest, _opts?: RequestOptions): Promise<ExitResponse> {
    throw new Error("not implemented");
  }

  probe(_opts?: ProbeOptions): Promise<ProbeResult> {
    throw new Error("not implemented");
  }

  close(): Promise<void> {
    throw new Error("not implemented");
  }
}
