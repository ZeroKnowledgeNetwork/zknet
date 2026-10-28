// Logging through `anonRpcWorker.log` (Anon-RPC SPEC v0.3.2 §13).
//
// Every entry is `("zknet-worker", event, fields?)`: `event` is a stable
// name (`boot.start`, `ready`, `call.failed`, ...) and `fields` a flat object
// of primitives. The worker never logs the peer's address, URLs, bodies or
// JSON-RPC methods and params; `redact` is a second line of defence for free
// text from lower layers. Delivery is best effort: a throwing host log never
// affects the worker.

import type { LogApi, LogArg } from "./spec-types.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface WorkerLogger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Change the threshold (the config is read after `boot.start`). */
  setLevel(level: LogLevel): void;
}

/** Source tag of every entry. */
export const LOG_SOURCE = "zknet-worker";

export function createLogger(api: LogApi | undefined, level: LogLevel = "info"): WorkerLogger {
  let min = LOG_LEVELS.indexOf(level);
  const emit = (entryLevel: LogLevel, event: string, fields?: LogFields): void => {
    if (api === undefined || LOG_LEVELS.indexOf(entryLevel) < min) return;
    const args: LogArg[] = [LOG_SOURCE, event];
    if (fields !== undefined) args.push(sanitize(fields));
    try {
      api[entryLevel](...args);
    } catch {
      // Best effort: a lost log line is never a worker failure.
    }
  };
  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    setLevel: (next) => {
      min = LOG_LEVELS.indexOf(next);
    },
  };
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/giu;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/gu;
const LONG_HEX_RE = /\b(?:0x)?[0-9a-fA-F]{32,}\b/gu;
// oxlint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/gu;
export const MAX_LOGGED_TEXT = 300;

/** Remove what must never reach host logs from free text: URLs, addresses, long hex, control characters. Bounded. */
export function redact(text: string): string {
  const cleaned = text
    .replace(URL_RE, "<url>")
    .replace(IPV4_RE, "<addr>")
    .replace(LONG_HEX_RE, "<hex>")
    .replace(CONTROL_RE, " ");
  return cleaned.length <= MAX_LOGGED_TEXT ? cleaned : `${cleaned.slice(0, MAX_LOGGED_TEXT)}…`;
}

function sanitize(fields: LogFields): { [key: string]: LogArg } {
  const out: { [key: string]: LogArg } = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = typeof value === "string" ? redact(value) : value;
  }
  return out;
}
