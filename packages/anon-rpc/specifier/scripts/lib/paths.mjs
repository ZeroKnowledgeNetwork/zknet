// Fixed locations of this project, resolved from this file so every script
// works from any CWD (Nx runs targets from the workspace root).

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const WORKSPACE_DIR = resolve(PROJECT_DIR, "../../..");

/** The worker bundle contract: the worker project emits its bundle here. */
export const DEFAULT_BUNDLE = join(PROJECT_DIR, "../worker/dist/zknet-anon-rpc-worker.js");

/**
 * EF's passthrough reference bundle, the stand-in until the worker bundle exists. Stored
 * extensionless at its content address (EF's keccak-branch layout) so no formatter rewrites it.
 */
export const FIXTURE_BUNDLE = join(
  PROJECT_DIR,
  "fixtures/keccak/19/4f04bde4925f6bbb0bd8bdfceca7251125eaa0664ce3c0c25dce2a1545338d",
);

/** Runtime state of the local loop (gitignored): pid files, logs, resolver store, deployments. */
export const STATE_DIR = join(PROJECT_DIR, ".state");
export const RESOLVER_STORE = join(STATE_DIR, "keccak");
export const DEPLOYMENTS_DIR = join(STATE_DIR, "deployments");

/** Working records of the public tiers (untracked): what deploy reads and writes. */
export const WORKING_RECORDS_DIR = join(STATE_DIR, "records");

/** Posted records of the public tiers (committed by hand): deployments/<tier>.json. */
export const POSTED_RECORDS_DIR = join(PROJECT_DIR, "deployments");

/** Untracked per-machine config of the public tiers (see deploy.local.example.json). */
export const LOCAL_CONFIG = join(PROJECT_DIR, "deploy.local.json");

/** What preflight proved, per tier: the bundle hash and the commit it reproduces from. */
export const PREFLIGHT_DIR = join(STATE_DIR, "preflight");

/** Staged Cloudflare Pages sites, per tier, cumulative. */
export const PUBLISH_DIR = join(STATE_DIR, "publish");

/** Build outputs of this project (gitignored by the workspace's dist rule). */
export const DIST_DIR = join(PROJECT_DIR, "dist");

export const DEFAULT_RPC_URL = "http://127.0.0.1:8545";
export const DEFAULT_RESOLVER_PORT = 8546;
