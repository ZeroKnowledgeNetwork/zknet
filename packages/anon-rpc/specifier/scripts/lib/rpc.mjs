// Minimal JSON-RPC over fetch, for the few chain reads the scripts make
// directly (reads and writes that need ABI work go through cast/forge).

import { CliError } from "./proc.mjs";

/**
 * @param {string} url
 * @param {string} method
 * @param {unknown[]} [params]
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown>}
 */
export async function rpc(url, method, params = [], timeoutMs = 10_000) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new CliError(`${method} at ${url}: HTTP ${resp.status}`);
  const body = /** @type {{ result?: unknown, error?: { message?: string } }} */ (
    await resp.json()
  );
  if (body.error)
    throw new CliError(`${method} at ${url}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

/** @param {string} url @returns {Promise<boolean>} true if a chain answers eth_chainId */
export async function answers(url) {
  try {
    await rpc(url, "eth_chainId", [], 1000);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} url @returns {Promise<number>} */
export async function chainId(url) {
  return Number(await rpc(url, "eth_chainId"));
}

/** @param {string} url @param {string} address @returns {Promise<string>} runtime code, "0x" if none */
export async function code(url, address) {
  return /** @type {string} */ (await rpc(url, "eth_getCode", [address, "latest"]));
}
