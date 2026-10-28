// Reading a WorkerSpecifier back and checking its resolvers the way a
// harness admits a bundle (SPEC §4): fetch, require 200, hash, compare.

import { keccak256Hex } from "./keccak.mjs";
import { CliError, foundry, run } from "./proc.mjs";
import { code } from "./rpc.mjs";

/** keccak256 of the runtime code of EF's reference WorkerSpecifier (test/ReferenceBytecode.t.sol). */
export const REFERENCE_CODEHASH =
  "0xc4c54384a9c1f1201ef3711a7ed7ba20e078a432e85ecc4f8b14927587cc7b5f";

/** Bodies above this are refused, as the reference harness caps them (MAX_BUNDLE_BYTES). */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/**
 * @param {string} rpcUrl
 * @param {string} address
 * @param {string} signature e.g. "workerHash()(bytes32)"
 */
async function call(rpcUrl, address, signature) {
  const out = await run(foundry("cast"), [
    "call",
    "--json",
    "--rpc-url",
    rpcUrl,
    address,
    signature,
  ]);
  const decoded = JSON.parse(out);
  if (!Array.isArray(decoded) || decoded.length !== 1)
    throw new CliError(`unexpected cast output for ${signature}: ${out}`);
  return decoded[0];
}

/**
 * The specifier's public §4 surface plus what identifies the contract.
 * @param {string} rpcUrl
 * @param {string} address
 * @returns {Promise<{ workerHash: string, resolvers: string[], owner: string, codehash: string } | undefined>}
 *   undefined when the address holds no code (e.g. a restarted local chain)
 */
export async function readSpecifier(rpcUrl, address) {
  const runtime = await code(rpcUrl, address);
  if (runtime === "0x") return undefined;
  const codehash = keccak256Hex(Buffer.from(runtime.slice(2), "hex"));
  const workerHash = String(await call(rpcUrl, address, "workerHash()(bytes32)")).toLowerCase();
  const resolvers = /** @type {string[]} */ (
    await call(rpcUrl, address, "workerResolvers()(string[])")
  );
  const owner = String(await call(rpcUrl, address, "owner()(address)"));
  return { workerHash, resolvers, owner, codehash };
}

/**
 * Fetch one resolver entry as a harness would and report what it served.
 * Redirects are not followed (SPEC §4.2: alternatives are separate entries),
 * so a 3xx reports as a failure rather than as the target's bytes.
 * @param {string} entry
 * @param {string} expected 0x keccak256 the bytes must hash to
 * @returns {Promise<{ entry: string, ok: boolean, detail: string }>}
 */
export async function checkResolver(entry, expected) {
  if (!/^https?:\/\//.test(entry)) {
    return {
      entry,
      ok: true,
      detail: "not fetched here (non-http entry; harnesses handle kps:/blob:)",
    };
  }
  try {
    const resp = await fetch(entry, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (resp.status !== 200) {
      await resp.body?.cancel();
      return { entry, ok: false, detail: `HTTP ${resp.status}` };
    }
    const encoding = resp.headers.get("content-encoding");
    if (encoding && encoding !== "identity")
      return { entry, ok: false, detail: `unexpected content-encoding ${encoding}` };
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength > MAX_BUNDLE_BYTES)
      return { entry, ok: false, detail: `body exceeds ${MAX_BUNDLE_BYTES} bytes` };
    const got = keccak256Hex(bytes);
    return got === expected
      ? { entry, ok: true, detail: `200, ${bytes.byteLength} bytes, keccak256 ${got}` }
      : { entry, ok: false, detail: `serves other bytes (keccak256 ${got})` };
  } catch (error) {
    return {
      entry,
      ok: false,
      detail: `unreachable (${error instanceof Error ? error.message : error})`,
    };
  }
}

/** @param {string[]} a @param {string[]} b */
export const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
