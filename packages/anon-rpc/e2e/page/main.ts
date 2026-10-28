// The host page: a wallet's side of anon-rpc, driven by Playwright through
// window.e2e. Arguments and results are plain JSON so they cross
// page.evaluate(). The harness is whichever build the page bundle aliased:
// the npm-pinned package by default, a fork checkout in the fork tier.

import { AnonRpcWorker } from "@anon-rpc/browser-harness";
import type {
  BootRequest,
  BootResult,
  ErrorInfo,
  FetchRequest,
  FetchResult,
  LogLine,
} from "./api.js";

declare const __HARNESS__: string;

const workers = new Map<string, AnonRpcWorker>();

function errorInfo(e: unknown): ErrorInfo {
  const err = e as { name?: unknown; message?: unknown; code?: unknown };
  return {
    name: typeof err?.name === "string" ? err.name : "Error",
    message: typeof err?.message === "string" ? err.message : String(e),
    ...(typeof err?.code === "string" ? { code: err.code } : {}),
  };
}

/** preExisting.rpcProvider: the page's own JSON-RPC, used only to read the specifier. */
function provider(url: string) {
  let id = 0;
  return {
    async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
      });
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new Error(body.error.message ?? "rpc error");
      return body.result;
    },
  };
}

async function boot(req: BootRequest): Promise<BootResult> {
  const started = performance.now();
  let worker: AnonRpcWorker;
  try {
    worker = new AnonRpcWorker({
      address: req.address,
      preExisting: { rpcProvider: provider(req.rpcUrl) },
      ...(req.config === undefined ? {} : { config: req.config }),
      // PROPOSED field; the published harness ignores it, the fork tier's build reads it.
      ...(req.network === undefined ? {} : { network: req.network }),
    } as ConstructorParameters<typeof AnonRpcWorker>[0]);
  } catch (e) {
    return { ok: false, readyMs: 0, error: errorInfo(e), sandbox: null, allow: null };
  }
  workers.set(req.id, worker);
  const frame = () => [...document.querySelectorAll("iframe")].at(-1) ?? null;
  try {
    await Promise.race([
      worker.ready,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("ready timed out")), req.readyTimeoutMs),
      ),
    ]);
    const f = frame();
    return {
      ok: true,
      readyMs: performance.now() - started,
      sandbox: f?.getAttribute("sandbox") ?? null,
      allow: f?.getAttribute("allow") ?? null,
    };
  } catch (e) {
    return {
      ok: false,
      readyMs: performance.now() - started,
      error: errorInfo(e),
      sandbox: null,
      allow: null,
    };
  }
}

async function call(req: FetchRequest): Promise<FetchResult> {
  const worker = workers.get(req.id);
  if (!worker) throw new Error(`no worker ${req.id}`);
  const started = performance.now();
  try {
    const res = await worker.fetch(req.url, {
      method: req.method ?? "POST",
      headers: req.headers ?? { "content-type": "application/json" },
      ...(req.body === undefined ? {} : { body: req.body }),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    const headers: [string, string][] = [];
    res.headers.forEach((v, k) => headers.push([k, v]));
    return {
      ok: true,
      ms: performance.now() - started,
      status: res.status,
      headers,
      bodyText: await res.text(),
    };
  } catch (e) {
    return { ok: false, ms: performance.now() - started, error: errorInfo(e) };
  }
}

async function logs(id: string, max: number, waitMs: number): Promise<LogLine[]> {
  const worker = workers.get(id);
  if (!worker) throw new Error(`no worker ${id}`);
  const out: LogLine[] = [];
  while (out.length < max) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), waitMs);
    try {
      const entry = await worker.acceptLog({ signal: ctl.signal });
      out.push({ level: String(entry.level), args: JSON.parse(JSON.stringify(entry.args ?? [])) });
    } catch {
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

window.e2e = {
  harness: __HARNESS__,
  boot,
  fetch: call,
  logs,
  close(id) {
    workers.get(id)?.close();
    workers.delete(id);
  },
};
