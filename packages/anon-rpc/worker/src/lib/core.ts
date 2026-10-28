// The worker: serve Ethereum JSON-RPC `POST`s (Anon-RPC SPEC v0.3.2 §3.2)
// by handing the body to a Transport for the exit, and relay the upstream
// reply as the fetch response. Where the exit sends it follows from the
// call's URL (see route()). Everything else is refused with a code. Failures
// carry an Anon-RPC SPEC v0.3.2 §12 `code` and a stable `name` (see README).

import {
  classifyTarget,
  TransportError,
  WalletShieldTransport,
  type ExitTarget,
  type ProbeResult,
  type Transport,
} from "@zknet/anon-rpc-transport";
import { ConfigError, resolveConfig, type ResolvedConfig } from "./config.js";
import { MAX_REQUEST_BODY_BYTES, MAX_URL_LENGTH } from "./limits.js";
import { createLogger, redact, type WorkerLogger } from "./log.js";
import type {
  AnonFetchResponse,
  AnonRequestInit,
  AnonRpcWorkerApi,
  ByteBody,
  FetchCall,
} from "./spec-types.js";

/** An exit network key: path segments of letters, digits, `-`, `_` and `.`; the `_` namespace is WalletShield's own. */
const NETWORK_RE = /^[A-Za-z0-9-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

/** Why a call is not served: its code, stable name and log reason. */
interface Refusal {
  code: "unsupported" | "too-large";
  reason: "url" | "method" | "size";
  message: string;
}

/**
 * Where a call goes. Anon-RPC SPEC v0.3.2 §3.2 lets a worker enable RPC by
 * general web request access, by serving RPC at a nominated URL, or both.
 * This worker does both, told apart by the URL's origin:
 *
 * - **WalletShield's own URL** (`http://127.0.0.1:7070/ethereum/sepolia`):
 *   the nominated URL. Its path is the exit's `[Networks]` key, answered by
 *   the operator's provider — exactly as WalletShield serves any wallet.
 * - **Any other `https:` URL**: the user's provider, fetched by the exit
 *   under its destination policy. This is the web-request shape, limited to
 *   JSON-RPC `POST`.
 */
export function route(
  rawUrl: string,
  method: string,
  config: ResolvedConfig,
): ExitTarget | Refusal {
  const refuse = (message: string, reason: Refusal["reason"] = "url"): Refusal => ({
    code: "unsupported",
    reason,
    message,
  });
  if (method.toUpperCase() !== "POST")
    return refuse("this worker serves JSON-RPC POST only", "method");
  if (rawUrl.length > MAX_URL_LENGTH)
    return {
      code: "too-large",
      reason: "url",
      message: `the URL is longer than ${MAX_URL_LENGTH} characters`,
    };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return refuse("the URL must be absolute: a provider https URL, or a WalletShield network URL");
  }
  if (url.hash || url.username || url.password)
    return refuse("the URL must not carry a fragment or credentials");

  const walletshield = new URL(config.walletshield).origin;
  if (url.origin === walletshield) {
    const network = url.pathname.slice(1);
    if (url.search || !NETWORK_RE.test(network))
      return refuse(`not a WalletShield network path: ${url.pathname}`);
    return { network };
  }
  if (classifyTarget(url))
    return refuse(
      `a local URL that is not the configured WalletShield (${walletshield}); set config.walletshield`,
    );
  if (url.protocol !== "https:") return refuse("a provider URL must be https");
  return { url: url.href };
}

function isRefusal(r: ExitTarget | Refusal): r is Refusal {
  return "reason" in r;
}

/** Codes passed to `signalFailed` (permanent: this bundle cannot run here). */
export const FAILED_CODES = {
  badConfig: "bad-config",
  unsupportedPlatform: "unsupported-platform",
} as const;

/** Least time between two diagnostic probes triggered by failing calls. */
export const PROBE_COOLDOWN_MS = 10_000;

export interface WorkerDeps {
  /** Bundle version, logged at boot. */
  version: string;
  /** Builds the transport; WalletShieldTransport by default. Test seam. */
  createTransport?: (config: ResolvedConfig) => Transport;
  now?: () => number;
}

/** A refusal or failure the host sees: `{ name, message, code }` across the harness. */
export class WorkerCallError extends Error {
  override readonly name: string;
  readonly code: string;
  constructor(code: string, name: string, message: string) {
    super(message);
    this.code = code;
    this.name = name;
  }
}

export async function runWorker(api: AnonRpcWorkerApi, deps: WorkerDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const log = createLogger(api.log);
  log.info("boot.start", { version: deps.version });

  const fail = (code: string, message: string): void => {
    log.error("worker.failed", { code, reason: message });
    api.signalFailed({ code, message });
  };

  if (
    typeof fetch !== "function" ||
    typeof AbortSignal?.any !== "function" ||
    typeof AbortSignal.timeout !== "function"
  ) {
    fail(
      FAILED_CODES.unsupportedPlatform,
      "this worker needs fetch, AbortSignal.any and AbortSignal.timeout",
    );
    return;
  }

  let config: ResolvedConfig;
  let transport: Transport;
  try {
    config = resolveConfig(api.config);
    log.setLevel(config.logLevel);
    transport = (deps.createTransport ?? defaultTransport)(config);
  } catch (e) {
    if (e instanceof ConfigError || (e instanceof TransportError && e.name === "TargetRefused")) {
      fail(FAILED_CODES.badConfig, e.message);
      return;
    }
    throw e;
  }
  log.info("boot.config", {
    peer: transport.peer,
    target: transport instanceof WalletShieldTransport ? transport.target : undefined,
    timeoutMs: config.timeoutMs,
  });

  // A peer that is down now may be started later: readiness does not wait on
  // it, and failure would be final (Anon-RPC SPEC v0.3.2 §7). The probe only diagnoses.
  api.signalReady();
  log.info("ready");

  const diagnose = probeLogger(transport, log, now);
  void diagnose(true);

  for (let seq = 1; ; seq++) {
    let call;
    try {
      call = await api.acceptCall();
    } catch (e) {
      log.error("accept.failed", { reason: redact(describe(e)) });
      await transport.close();
      return;
    }
    if (call.kind !== "fetch") {
      log.debug("call.ignored", { kind: String((call as { kind?: unknown }).kind).slice(0, 32) });
      continue; // Anon-RPC SPEC v0.3.2 §8: ignore kinds this worker does not know
    }
    try {
      call.respond(handle(call, seq, config, transport, log, diagnose, now));
    } catch (e) {
      log.error("respond.failed", { seq, reason: redact(describe(e)) });
    }
  }
}

function defaultTransport(config: ResolvedConfig): Transport {
  return new WalletShieldTransport({ url: config.walletshield, timeoutMs: config.timeoutMs });
}

async function handle(
  call: FetchCall,
  seq: number,
  config: ResolvedConfig,
  transport: Transport,
  log: WorkerLogger,
  diagnose: (force?: boolean) => Promise<void>,
  now: () => number,
): Promise<AnonFetchResponse> {
  const started = now();
  const init: AnonRequestInit = call.requestInit ?? {};

  const target = route(call.url, init.method ?? "GET", config);
  if (isRefusal(target)) return refused(log, seq, target);
  const kind = target.url === undefined ? "network" : "url";
  const failed = (e: unknown): Error => {
    const error =
      e instanceof TransportError || e instanceof WorkerCallError
        ? e
        : init.signal?.aborted
          ? aborted()
          : internal(e);
    log.warn("call.failed", {
      seq,
      route: kind,
      code: error.code,
      name: error.name,
      ms: now() - started,
    });
    if (
      e instanceof TransportError &&
      (error.code === "network-error" ||
        error.code === "permission-denied" ||
        error.code === "unsupported")
    )
      void diagnose();
    return error;
  };

  let body: Uint8Array | undefined;
  try {
    body = await readAll(init.body, init.signal);
  } catch (e) {
    throw failed(e);
  }
  if (body === undefined)
    return refused(log, seq, {
      code: "too-large",
      reason: "size",
      message: `the request body is larger than ${MAX_REQUEST_BODY_BYTES} bytes`,
    });

  try {
    const res = await transport.request(
      { ...target, body, contentType: header(init, "content-type") ?? "application/json" },
      { signal: init.signal },
    );
    // The exit relays a redirect, never follows it. Fetch's `error` mode makes one a network error.
    if (init.redirect === "error" && res.status >= 300 && res.status < 400) {
      throw new WorkerCallError(
        "network-error",
        "RedirectRefused",
        `the provider answered with a redirect (${res.status})`,
      );
    }
    log.debug("call.done", {
      seq,
      ms: now() - started,
      route: kind,
      outcome: "ok",
      status: res.status,
      bytesOut: body.byteLength,
      bytesIn: res.body.byteLength,
    });
    return { status: res.status, headers: res.headers, body: res.body, url: call.url };
  } catch (e) {
    throw failed(e);
  }
}

function refused(log: WorkerLogger, seq: number, r: Refusal): never {
  log.warn("call.refused", { seq, reason: r.reason });
  throw new WorkerCallError(
    r.code,
    r.code === "too-large" ? "TooLarge" : "UnsupportedRequest",
    r.message,
  );
}

function header(init: AnonRequestInit, name: string): string | undefined {
  return init.headers?.find(([k]) => k.toLowerCase() === name)?.[1];
}

/** Probe at boot and after failing calls (one at a time; failure-triggered probes rate-limited), logging what it finds. */
function probeLogger(
  transport: Transport,
  log: WorkerLogger,
  now: () => number,
): (force?: boolean) => Promise<void> {
  let running = false;
  let last = -Infinity;
  return async (force = false) => {
    if (running || (!force && now() - last < PROBE_COOLDOWN_MS)) return;
    running = true;
    if (!force) last = now();
    try {
      const r: ProbeResult = await transport.probe();
      const fields = {
        reach: r.reach,
        ms: r.ms,
        version: r.peerVersion,
        code: r.error?.code,
        name: r.error?.name,
      };
      if (r.error) log.warn("probe", fields);
      else log.info("probe", fields);
    } catch (e) {
      log.warn("probe", { reach: "none", reason: redact(describe(e)) });
    } finally {
      running = false;
    }
  };
}

/** The whole body, or undefined past MAX_REQUEST_BODY_BYTES (a stream is not read further). */
async function readAll(
  body: ByteBody | undefined,
  signal: AbortSignal | undefined,
): Promise<Uint8Array | undefined> {
  if (body === undefined) return new Uint8Array(0);
  if (body instanceof Uint8Array)
    return body.byteLength > MAX_REQUEST_BODY_BYTES ? undefined : body;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw aborted();
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return undefined;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (signal?.aborted) throw aborted();
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function aborted(): TransportError {
  return new TransportError("cancelled", "AbortError", "the request was aborted");
}

function internal(e: unknown): WorkerCallError {
  return new WorkerCallError("internal-error", "InternalError", redact(describe(e)));
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
