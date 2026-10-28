// WalletShieldTransport: the minimal path. WalletShield is the ZKNet client's
// local HTTP listener; it serializes the request it receives, sends it
// through the mixnet to the `rpc_proxy` exit, and answers with the exit's
// relay of the upstream reply.
//
// The reply contract (WalletShield + exit, shared with this transport):
// - a reply WalletShield or the exit *originates* carries `ZKNet-Error:
//   <reason>` and a JSON body `{"error":{"reason","message"}}`; its presence,
//   never the status alone, marks a transport failure;
// - any other reply is the upstream's: its status, allowlisted headers and
//   body, relayed as-is;
// - `GET /_/health` is answered locally, without the mixnet.
//
// A request goes to `POST /<network>` for a `[Networks]` key, or to
// `POST /_/url` with the provider URL in the `ZKNet-URL` header. The header
// keeps the URL, which often embeds an API key, out of request lines and
// logs; WalletShield moves it into the exit request.

import { TransportError, zknetError } from "./errors.js";
import { classifyTarget, TARGET_SCHEMES, type TargetClass } from "./targets.js";
import type {
  ExitRequest,
  ExitResponse,
  HeaderList,
  ProbeOptions,
  ProbeResult,
  RequestOptions,
  Transport,
  TransportErrorShape,
} from "./types.js";

/** WalletShield's conventional listen address (the binary has no default; `-listen` is required). */
export const DEFAULT_WALLETSHIELD_URL = "http://127.0.0.1:7070";

/** Upstream headers relayed to the caller. Keep in step with the exit's allowlist. */
export const UPSTREAM_HEADERS: readonly string[] = ["content-type", "retry-after"];

/** The header that marks a reply WalletShield or the exit originated. */
export const ZKNET_ERROR_HEADER = "zknet-error";

/** WalletShield's provider-selection endpoint, and the header that names the provider. */
export const USER_URL_PATH = "/_/url";
export const URL_HEADER = "zknet-url";

/** Local health path (answered by WalletShield itself) and exit probe path (one mix round trip). */
export const HEALTH_PATH = "/_/health";
export const EXIT_PROBE_PATH = "/_/probe/0";

/** Default per-request deadline. Above WalletShield's own `-timeout` (20 s) so its `mix-timeout` wins. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface WalletShieldOptions {
  /** Base URL of the WalletShield listener. Default DEFAULT_WALLETSHIELD_URL. */
  url?: string;
  /** Per-request deadline in ms. Default DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Test seam; the ambient `fetch` otherwise. */
  fetch?: typeof fetch;
  /** Test seam; `globalThis.isSecureContext` otherwise. */
  isSecureContext?: boolean;
}

export class WalletShieldTransport implements Transport {
  readonly peer = "walletshield" as const;
  readonly target: TargetClass;

  readonly #base: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #secure: boolean;
  readonly #protocol: string;
  #closed = new AbortController();

  /** Throws a TransportError (`unsupported` / `TargetRefused`) for a remote or malformed URL. */
  constructor(opts: WalletShieldOptions = {}) {
    const raw = opts.url ?? DEFAULT_WALLETSHIELD_URL;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw refused("the WalletShield URL is not a URL");
    }
    if (!(TARGET_SCHEMES.walletshield as readonly string[]).includes(url.protocol)) {
      throw refused(
        `WalletShield URL scheme must be one of ${TARGET_SCHEMES.walletshield.join(" ")}`,
      );
    }
    if (url.username || url.password || url.search || url.hash) {
      throw refused("the WalletShield URL must not carry credentials, a query or a fragment");
    }
    const target = classifyTarget(url);
    if (!target) throw refused("the WalletShield URL is not a loopback or local-network address");
    this.target = target;
    this.#protocol = url.protocol;
    this.#base = url.href.replace(/\/+$/, "");
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!(Number.isFinite(timeoutMs) && timeoutMs > 0))
      throw refused("timeoutMs must be a positive number");
    this.#timeoutMs = timeoutMs;
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#secure = opts.isSecureContext ?? globalThis.isSecureContext === true;
  }

  /** True when the browser is expected to block this target as mixed content (an `http:` LAN peer from a secure context). */
  get mixedContentPredicted(): boolean {
    return this.#secure && this.#protocol === "http:" && this.target === "lan";
  }

  async request(req: ExitRequest, opts: RequestOptions = {}): Promise<ExitResponse> {
    const [path, headers]: [string, Record<string, string>] =
      req.url !== undefined
        ? [USER_URL_PATH, { "content-type": req.contentType, [URL_HEADER]: req.url }]
        : [`/${req.network.replace(/^\/+/, "")}`, { "content-type": req.contentType }];
    return this.#exchange(
      path,
      {
        method: "POST",
        headers,
        // A copy over exactly the request bytes: `fetch` reads a view's whole buffer otherwise.
        body: req.body.slice(),
      },
      opts.signal,
      async (res) => {
        const body = new Uint8Array(await res.arrayBuffer());
        const headers: HeaderList = [];
        res.headers.forEach((value, name) => {
          if (UPSTREAM_HEADERS.includes(name.toLowerCase()))
            headers.push([name.toLowerCase(), value]);
        });
        return { status: res.status, headers, body };
      },
    );
  }

  async probe(opts: ProbeOptions = {}): Promise<ProbeResult> {
    const started = Date.now();
    const done = (r: Omit<ProbeResult, "ms">): ProbeResult => ({ ...r, ms: Date.now() - started });

    // Peer tier: WalletShield answers its health path locally.
    let peerVersion: string | undefined;
    try {
      peerVersion = await this.#exchange(
        HEALTH_PATH,
        { method: "GET" },
        opts.signal,
        async (res) => {
          const json = (await res.json().catch(() => undefined)) as
            | { version?: unknown }
            | undefined;
          return res.status === 200 && typeof json?.version === "string" ? json.version : undefined;
        },
      );
    } catch (e) {
      const error = shape(e);
      if (error.name === "PeerUnreachable" && (await this.#answersOpaquely(opts.signal))) {
        // Something answers, but its replies are unreadable from here.
        return done({
          reach: "peer",
          error: {
            code: "permission-denied",
            name: "CorsRejected",
            message: "WalletShield answered, but its reply is not readable from this origin (CORS)",
          },
        });
      }
      // A marked failure on the health path: the peer answered, but not as WalletShield does.
      if (MARKED.has(error.name)) return done({ reach: "peer", error });
      return done({ reach: "none", error });
    }

    if ((opts.depth ?? "peer") === "peer") return done({ reach: "peer", peerVersion });

    // Exit tier: one probe through the mixnet; the exit answers its probe path itself.
    try {
      await this.#exchange(
        EXIT_PROBE_PATH,
        { method: "POST", headers: { "content-type": "application/json" }, body: "" },
        opts.signal,
        async (res) => {
          await res.arrayBuffer();
        },
      );
      return done({ reach: "exit", peerVersion });
    } catch (e) {
      const error = shape(e);
      // The exit answered unless the failure happened before it could.
      if (MARKED.has(error.name) && error.name !== "MixTimeout" && error.name !== "TooLarge")
        return done({ reach: "exit", peerVersion });
      return done({ reach: "peer", peerVersion, error });
    }
  }

  async close(): Promise<void> {
    this.#closed.abort();
    this.#closed = new AbortController();
  }

  /**
   * One HTTP exchange with WalletShield under the caller's signal, the
   * deadline and `close()`. A `ZKNet-Error` reply rejects; `read` consumes
   * every other reply.
   *
   * No `targetAddressSpace`: Chromium needs it only for a public host name
   * that resolves to a local address, which targets.ts refuses, and it
   * refuses any fetch naming one once that fetch goes through a browser proxy.
   */
  async #exchange<T>(
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    read: (res: Response) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw aborted();
    const deadline = AbortSignal.timeout(this.#timeoutMs);
    const closed = this.#closed.signal;
    const combined = AbortSignal.any([deadline, closed, ...(signal ? [signal] : [])]);
    const why = (): TransportError | undefined =>
      signal?.aborted
        ? aborted()
        : closed.aborted
          ? new TransportError("closed", "Closed", "the transport was closed")
          : deadline.aborted
            ? new TransportError(
                "timeout",
                "Deadline",
                `no reply from WalletShield within ${this.#timeoutMs} ms`,
              )
            : undefined;
    try {
      const res = await this.#fetch(`${this.#base}${path}`, {
        ...init,
        credentials: "omit",
        cache: "no-store",
        // A provider's 3xx is relayed as the reply. Under Fetch's `error` mode
        // any 3xx is a network error, and under `manual` an opaque status 0,
        // so neither can carry it. WalletShield never relays `Location`, so
        // `follow` returns the 3xx as it is; a reply that was redirected
        // anyway did not come from WalletShield and is refused below.
        redirect: "follow",
        signal: combined,
      });
      if (res.redirected)
        throw new TransportError(
          "protocol-error",
          "UnexpectedReply",
          "the peer redirected the request; WalletShield never does",
        );
      const reason = res.headers.get(ZKNET_ERROR_HEADER);
      if (reason !== null) throw zknetError(reason.trim(), await errorMessage(res));
      return await read(res);
    } catch (e) {
      if (e instanceof TransportError) throw e;
      throw why() ?? this.#networkFailure(e);
    }
  }

  /**
   * Name a `fetch` that failed before a readable reply. From inside the
   * harness's frame the browser shows one `TypeError` for every cause — the
   * peer not running, Local Network Access not delegated or not granted —
   * and `permissions.query` there reads `denied` even when access works, so
   * those stay one name. Only a mixed-content block is predictable.
   */
  #networkFailure(cause: unknown): TransportError {
    if (this.mixedContentPredicted) {
      return new TransportError(
        "unsupported",
        "MixedContentBlocked",
        "the browser blocks an http: local-network peer from a secure context (mixed content)",
        { cause },
      );
    }
    return new TransportError(
      "network-error",
      "PeerUnreachable",
      "WalletShield did not answer: it is not running at the configured address, or the browser blocked local network access (not delegated by the host, or not granted)",
      { cause },
    );
  }

  /** Whether anything answers the health path when CORS is taken out of the picture. */
  async #answersOpaquely(signal: AbortSignal | undefined): Promise<boolean> {
    try {
      await this.#fetch(`${this.#base}${HEALTH_PATH}`, {
        method: "GET",
        mode: "no-cors",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.any([
          AbortSignal.timeout(this.#timeoutMs),
          this.#closed.signal,
          ...(signal ? [signal] : []),
        ]),
      });
      return true;
    } catch {
      return false;
    }
  }
}

/** Failures marked by a `ZKNet-Error` reply, i.e. the peer answered. */
const MARKED: ReadonlySet<string> = new Set([
  "MixTimeout",
  "ExitRefused",
  "ExitBusy",
  "UpstreamUnreachable",
  "BadReply",
  "TooLarge",
  "UnexpectedReply",
]);

function refused(message: string): TransportError {
  return new TransportError("unsupported", "TargetRefused", message);
}

function aborted(): TransportError {
  return new TransportError("cancelled", "AbortError", "the request was aborted");
}

function shape(e: unknown): TransportErrorShape {
  if (e instanceof TransportError) return e.toJSON();
  return {
    code: "internal-error",
    name: "UnexpectedReply",
    message: e instanceof Error ? e.message : String(e),
  };
}

/** The diagnostic message of a `ZKNet-Error` reply's JSON body, if it has one. */
async function errorMessage(res: Response): Promise<string | undefined> {
  try {
    const json = (await res.json()) as { error?: { message?: unknown } };
    return typeof json?.error?.message === "string" ? json.error.message : undefined;
  } catch {
    return undefined;
  }
}
