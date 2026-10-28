// Bundle digests: keccak-256 is the identity a specifier pins (SPEC §4);
// sha256 and the byte count are informational build fingerprints.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Keccak256 } from "./keccak.mjs";
import { CliError } from "./proc.mjs";

/**
 * @typedef {object} FileDigest
 * @property {string} file       path as given
 * @property {number} bytes      exact byte length
 * @property {string} keccak256  0x-prefixed lowercase hex
 * @property {string} sha256     lowercase hex
 */

/**
 * Stream a file once and return both digests and its size.
 * @param {string} file
 * @returns {Promise<FileDigest>}
 */
export async function digestFile(file) {
  const keccak = new Keccak256();
  const sha = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(file)) {
      keccak.update(chunk);
      sha.update(chunk);
      bytes += chunk.byteLength;
    }
  } catch (error) {
    throw new CliError(
      `cannot read bundle ${file}: ${error instanceof Error ? error.message : error}`,
    );
  }
  return {
    file,
    bytes,
    keccak256: `0x${Buffer.from(keccak.digest()).toString("hex")}`,
    sha256: sha.digest("hex"),
  };
}

/**
 * The content address of a bundle: "<hash[0:2]>/<hash[2:]>" over the 64 hex
 * digits, the layout of EF's `keccak` resolver branch.
 * @param {string} keccak256 0x-prefixed hex
 */
export function contentPath(keccak256) {
  const hex = keccak256.replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new CliError(`not a keccak256 digest: ${keccak256}`);
  return `${hex.slice(0, 2)}/${hex.slice(2)}`;
}
