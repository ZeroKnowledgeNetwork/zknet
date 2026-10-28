// Entry point of the ZKNet anon-rpc worker bundle: one classic-script IIFE
// that the anon-rpc harness runs with `anonRpcWorker` installed (Anon-RPC
// SPEC v0.3.2 §7).
// Everything else lives in lib/core.ts.

import { runWorker } from "./lib/core.js";
import type { AnonRpcWorkerApi } from "./lib/spec-types.js";

declare const anonRpcWorker: AnonRpcWorkerApi;
declare const __ZKNET_WORKER_VERSION__: string;

runWorker(anonRpcWorker, { version: __ZKNET_WORKER_VERSION__ }).catch((e: unknown) => {
  // An escaped error is a bug; report it as the final failure rather than hang (Anon-RPC SPEC v0.3.2 §5).
  anonRpcWorker.signalFailed({
    code: "internal-error",
    message: e instanceof Error ? e.message : String(e),
  });
});
