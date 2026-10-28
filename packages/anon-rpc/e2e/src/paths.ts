import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ANON_RPC_DIR = resolve(E2E_DIR, "..");

/** The bundle contract with the worker project, and the specifier project's CLIs. */
export const WORKER_BUNDLE = join(ANON_RPC_DIR, "worker/dist/zknet-anon-rpc-worker.js");
export const SPECIFIER_SCRIPTS = join(ANON_RPC_DIR, "specifier/scripts");

/** Per-run scratch space (gitignored). */
export const RUN_DIR = join(E2E_DIR, ".run");
