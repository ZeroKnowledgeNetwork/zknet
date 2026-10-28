// The worker's own config schema (Anon-RPC SPEC v0.3.2 §7.1: opaque to the
// harness). The host passes it as `WorkerInit.config`; every key is optional.

import { DEFAULT_TIMEOUT_MS, DEFAULT_WALLETSHIELD_URL } from '@zknet/anon-rpc-transport';
import { LOG_LEVELS, type LogLevel } from './log.js';

export interface ZknetWorkerConfig {
  /** WalletShield's listener: loopback or local network only. Default `http://127.0.0.1:7070`. */
  walletshield?: string;
  /** Per-request deadline in ms. Default 30000 (above WalletShield's own 20 s). */
  timeoutMs?: number;
  /** Lowest level forwarded to `anonRpcWorker.log`. Default `info`. */
  logLevel?: LogLevel;
}

export type ResolvedConfig = Required<ZknetWorkerConfig>;

export const DEFAULT_CONFIG: ResolvedConfig = {
  walletshield: DEFAULT_WALLETSHIELD_URL,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  logLevel: 'info',
};

export class ConfigError extends Error {
  readonly code = 'bad-config';
}

/** Validate `anonRpcWorker.config`. Throws a ConfigError naming the first problem. */
export function resolveConfig(raw: unknown): ResolvedConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_CONFIG };
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new ConfigError('config must be an object');
  const cfg = raw as Record<string, unknown>;
  for (const key of Object.keys(cfg)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new ConfigError(`unknown config key "${key}"`);
  }
  const out = { ...DEFAULT_CONFIG };
  if (cfg.walletshield !== undefined) {
    if (typeof cfg.walletshield !== 'string')
      throw new ConfigError('walletshield must be a URL string');
    out.walletshield = cfg.walletshield;
  }
  if (cfg.timeoutMs !== undefined) {
    if (
      typeof cfg.timeoutMs !== 'number' ||
      !Number.isFinite(cfg.timeoutMs) ||
      cfg.timeoutMs <= 0
    ) {
      throw new ConfigError('timeoutMs must be a positive number');
    }
    out.timeoutMs = cfg.timeoutMs;
  }
  if (cfg.logLevel !== undefined) {
    if (!LOG_LEVELS.includes(cfg.logLevel as LogLevel))
      throw new ConfigError(`logLevel must be one of ${LOG_LEVELS.join(', ')}`);
    out.logLevel = cfg.logLevel as LogLevel;
  }
  return out;
}
