// Ethereum Keccak-256: the function behind Solidity's keccak256 and the
// reference harness's admission check (anon-rpc SPEC §4). It is NOT the
// FIPS-202 SHA3-256 that node:crypto ships: the two differ in one padding
// byte (0x01 here, 0x06 there) and give unrelated digests, and OpenSSL does
// not expose the original Keccak through Node. So it lives here, in plain
// JavaScript, keeping this package free of npm dependencies.
//
// Lanes are 64-bit, held as (lo, hi) pairs of 32-bit words.

const RATE = 136; // bytes absorbed per permutation: (1600 - 2 * 256) / 8

// Round constants of iota, as [lo, hi] words.
const RC = [
  0x00000001, 0x00000000, 0x00008082, 0x00000000, 0x0000808a, 0x80000000, 0x80008000, 0x80000000,
  0x0000808b, 0x00000000, 0x80000001, 0x00000000, 0x80008081, 0x80000000, 0x00008009, 0x80000000,
  0x0000008a, 0x00000000, 0x00000088, 0x00000000, 0x80008009, 0x00000000, 0x8000000a, 0x00000000,
  0x8000808b, 0x00000000, 0x0000008b, 0x80000000, 0x00008089, 0x80000000, 0x00008003, 0x80000000,
  0x00008002, 0x80000000, 0x00000080, 0x80000000, 0x0000800a, 0x00000000, 0x8000000a, 0x80000000,
  0x80008081, 0x80000000, 0x00008080, 0x80000000, 0x80000001, 0x00000000, 0x80008008, 0x80000000,
];

// rho rotation offsets and pi destinations, walked along the pi cycle from lane 1.
const ROTC = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
];
const PILN = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
];

/** keccak-f[1600] over 25 lanes stored as 50 little-endian 32-bit words. */
function permute(s) {
  const c = new Uint32Array(10);
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 10; x++) c[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
    for (let x = 0; x < 10; x += 2) {
      const n = (x + 2) % 10;
      const p = (x + 8) % 10;
      const lo = c[p] ^ ((c[n] << 1) | (c[n + 1] >>> 31));
      const hi = c[p + 1] ^ ((c[n + 1] << 1) | (c[n] >>> 31));
      for (let y = 0; y < 50; y += 10) {
        s[x + y] ^= lo;
        s[x + y + 1] ^= hi;
      }
    }
    // rho + pi
    let lo = s[2];
    let hi = s[3];
    for (let i = 0; i < 24; i++) {
      const j = PILN[i] * 2;
      const tlo = s[j];
      const thi = s[j + 1];
      const r = ROTC[i];
      if (r < 32) {
        s[j] = (lo << r) | (hi >>> (32 - r));
        s[j + 1] = (hi << r) | (lo >>> (32 - r));
      } else {
        s[j] = (hi << (r - 32)) | (lo >>> (64 - r));
        s[j + 1] = (lo << (r - 32)) | (hi >>> (64 - r));
      }
      lo = tlo;
      hi = thi;
    }
    // chi
    for (let y = 0; y < 50; y += 10) {
      for (let x = 0; x < 10; x++) c[x] = s[y + x];
      for (let x = 0; x < 10; x++) s[y + x] ^= ~c[(x + 2) % 10] & c[(x + 4) % 10];
    }
    // iota
    s[0] ^= RC[round * 2];
    s[1] ^= RC[round * 2 + 1];
  }
}

/** Incremental Keccak-256: update() any number of times, then digest() once. */
export class Keccak256 {
  #state = new Uint32Array(50);
  #block = new Uint8Array(RATE);
  #fill = 0;
  #done = false;

  /** @param {Uint8Array} bytes */
  update(bytes) {
    if (this.#done) throw new Error("keccak256: update after digest");
    for (let i = 0; i < bytes.length; i++) {
      this.#block[this.#fill++] = bytes[i];
      if (this.#fill === RATE) this.#absorb();
    }
    return this;
  }

  /** @returns {Uint8Array} 32-byte digest */
  digest() {
    if (this.#done) throw new Error("keccak256: digest called twice");
    this.#done = true;
    this.#block.fill(0, this.#fill);
    this.#block[this.#fill] ^= 0x01;
    this.#block[RATE - 1] ^= 0x80;
    this.#absorb();
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      const w = this.#state[i];
      out[i * 4] = w;
      out[i * 4 + 1] = w >>> 8;
      out[i * 4 + 2] = w >>> 16;
      out[i * 4 + 3] = w >>> 24;
    }
    return out;
  }

  #absorb() {
    const b = this.#block;
    for (let i = 0; i < RATE / 4; i++) {
      this.#state[i] ^=
        b[i * 4] | (b[i * 4 + 1] << 8) | (b[i * 4 + 2] << 16) | (b[i * 4 + 3] << 24);
    }
    permute(this.#state);
    this.#fill = 0;
  }
}

/** @param {Uint8Array} bytes @returns {Uint8Array} */
export function keccak256(bytes) {
  return new Keccak256().update(bytes).digest();
}

/** @param {Uint8Array} bytes @returns {string} 0x-prefixed lowercase hex */
export function keccak256Hex(bytes) {
  return `0x${Buffer.from(keccak256(bytes)).toString("hex")}`;
}
