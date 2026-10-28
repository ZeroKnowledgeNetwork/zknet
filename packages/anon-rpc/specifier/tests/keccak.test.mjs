import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { contentPath } from "../scripts/lib/digest.mjs";
import { Keccak256, keccak256Hex } from "../scripts/lib/keccak.mjs";
import { FIXTURE_BUNDLE } from "../scripts/lib/paths.mjs";
import { foundry } from "../scripts/lib/proc.mjs";

const utf8 = (/** @type {string} */ s) => new TextEncoder().encode(s);

test("published Keccak-256 vectors", () => {
  assert.equal(
    keccak256Hex(utf8("")),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
  assert.equal(
    keccak256Hex(utf8("abc")),
    "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
  );
});

test("is Keccak, not FIPS-202 SHA3-256", () => {
  const sha3 = `0x${createHash("sha3-256").update("").digest("hex")}`;
  assert.notEqual(keccak256Hex(utf8("")), sha3);
});

test("the fixture hashes to its EF keccak-branch content address", () => {
  const hash = keccak256Hex(readFileSync(FIXTURE_BUNDLE));
  assert.equal(hash, "0x194f04bde4925f6bbb0bd8bdfceca7251125eaa0664ce3c0c25dce2a1545338d");
  assert.equal(
    contentPath(hash),
    "19/4f04bde4925f6bbb0bd8bdfceca7251125eaa0664ce3c0c25dce2a1545338d",
  );
});

test("incremental updates equal one-shot, across every rate boundary", () => {
  for (const n of [0, 1, 135, 136, 137, 271, 272, 273, 4096]) {
    const bytes = randomBytes(n);
    const k = new Keccak256();
    for (let i = 0; i < n; i += 7) k.update(bytes.subarray(i, i + 7));
    assert.equal(
      `0x${Buffer.from(k.digest()).toString("hex")}`,
      keccak256Hex(bytes),
      `length ${n}`,
    );
  }
});

test("agrees with cast keccak on random bytes", (t) => {
  let cast;
  try {
    cast = foundry("cast");
  } catch {
    t.skip("cast not installed");
    return;
  }
  for (const n of [1, 136, 1000, 30_000]) {
    const bytes = randomBytes(n);
    const expected = execFileSync(cast, ["keccak", `0x${bytes.toString("hex")}`], {
      encoding: "utf8",
    }).trim();
    assert.equal(keccak256Hex(bytes), expected, `length ${n}`);
  }
  // Solidity selectors are the first four bytes of the signature's keccak.
  for (const sig of ["workerHash()", "workerResolvers()", "setWorker(bytes32,string[])"]) {
    const selector = execFileSync(cast, ["sig", sig], { encoding: "utf8" }).trim();
    assert.equal(keccak256Hex(utf8(sig)).slice(0, 10), selector, sig);
  }
});
