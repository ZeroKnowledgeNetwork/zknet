// The local resolver against the semantics a harness checks (SPEC §4.1/§4.2):
// 200 with the exact bytes, nothing else is 200, nothing redirects, and no
// content coding stands between the body and the hash.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { contentPath } from "../scripts/lib/digest.mjs";
import { keccak256Hex } from "../scripts/lib/keccak.mjs";
import { FIXTURE_BUNDLE } from "../scripts/lib/paths.mjs";
import { checkResolver } from "../scripts/lib/specifier.mjs";
import { createResolverServer, put } from "../scripts/resolver.mjs";

const bundle = readFileSync(FIXTURE_BUNDLE);
const hash = keccak256Hex(bundle);
const store = mkdtempSync(join(tmpdir(), "zknet-resolver-test-"));
const server = createResolverServer(store);
let origin = "";

before(async () => {
  await put(FIXTURE_BUNDLE, store);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
  rmSync(store, { recursive: true, force: true });
});

const url = (/** @type {string} */ h) => `${origin}/keccak/${contentPath(h)}`;

/**
 * Raw request without fetch's conveniences, to see exactly what is on the wire.
 * @param {string} method
 * @param {string} path
 * @returns {Promise<{ status: number, headers: import("node:http").IncomingHttpHeaders, body: Buffer }>}
 */
function raw(method, path) {
  return new Promise((resolve, reject) => {
    // host/port/path options, not a URL string: a URL would be normalized (".." resolved) before sending.
    const { hostname, port } = new URL(origin);
    const headers = { "accept-encoding": "gzip, deflate, br" };
    const req = request({ hostname, port, path, method, headers }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test("a stored bundle is 200 with exactly its bytes", async () => {
  const resp = await fetch(url(hash), { redirect: "manual" });
  assert.equal(resp.status, 200);
  assert.deepEqual(Buffer.from(await resp.arrayBuffer()), bundle);
});

test("the body is never content-coded, even when the client offers codings", async () => {
  const r = await raw("GET", `/keccak/${contentPath(hash)}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-encoding"], undefined);
  assert.equal(r.headers["transfer-encoding"], undefined);
  assert.equal(Number(r.headers["content-length"]), bundle.length);
  assert.deepEqual(r.body, bundle);
});

test("browser harnesses may fetch it cross-origin", async () => {
  const resp = await fetch(url(hash));
  assert.equal(resp.headers.get("access-control-allow-origin"), "*");
  await resp.arrayBuffer();
});

test("HEAD answers like GET without a body", async () => {
  const r = await raw("HEAD", `/keccak/${contentPath(hash)}`);
  assert.equal(r.status, 200);
  assert.equal(Number(r.headers["content-length"]), bundle.length);
  assert.equal(r.body.length, 0);
});

test("an unknown hash is 404, never a redirect", async () => {
  const resp = await fetch(url(`0x${"ab".repeat(32)}`), { redirect: "manual" });
  assert.equal(resp.status, 404);
  await resp.arrayBuffer();
});

test("only exact content addresses route: no prefixes, case variants, traversal or directory listings", async () => {
  const hex = hash.slice(2);
  for (const path of [
    "/",
    "/keccak/",
    `/keccak/${hex.slice(0, 2)}`,
    `/keccak/${hex.slice(0, 2)}/`,
    `/${hex.slice(0, 2)}/${hex.slice(2)}`,
    `/keccak/${hex.slice(0, 2).toUpperCase()}/${hex.slice(2).toUpperCase()}`,
    `/keccak/${hex}`,
    `/keccak/${hex.slice(0, 2)}/../${hex.slice(0, 2)}/${hex.slice(2)}`,
    `/keccak/${hex.slice(0, 2)}/${hex.slice(2)}/`,
  ]) {
    const r = await raw("GET", path);
    assert.ok(r.status === 404, `${path} -> ${r.status}`);
    assert.ok(r.status < 300 || r.status >= 400, `${path} redirected`);
  }
});

test("a query string does not change what a path names", async () => {
  const resp = await fetch(`${url(hash)}?v=2`);
  assert.equal(resp.status, 200);
  assert.deepEqual(Buffer.from(await resp.arrayBuffer()), bundle);
});

test("methods other than GET and HEAD are refused", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const r = await raw(method, `/keccak/${contentPath(hash)}`);
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, "GET, HEAD");
  }
});

test("a corrupted store entry is a 500, never the wrong bytes", async () => {
  const other = Buffer.from("// corrupted\n");
  const fakeHash = `0x${"cd".repeat(32)}`;
  const path = join(store, contentPath(fakeHash));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, other);
  const resp = await fetch(url(fakeHash));
  assert.equal(resp.status, 500);
  assert.equal((await resp.arrayBuffer()).byteLength, 0);
});

test("checkResolver admits it, and rejects other bytes, errors and redirects", async () => {
  assert.equal((await checkResolver(url(hash), hash)).ok, true);
  const wrong = await checkResolver(url(hash), `0x${"00".repeat(32)}`);
  assert.equal(wrong.ok, false);
  assert.match(wrong.detail, /serves other bytes/);
  assert.equal((await checkResolver(url(`0x${"ab".repeat(32)}`), hash)).ok, false);

  const redirector = createServer((_req, res) => {
    res.writeHead(302, { location: url(hash) }).end();
  });
  await new Promise((resolve) => redirector.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = redirector.address();
  assert.ok(address !== null && typeof address === "object");
  const redirected = await checkResolver(`http://127.0.0.1:${address.port}/w.js`, hash);
  redirector.close();
  assert.equal(redirected.ok, false);
  assert.equal(redirected.detail, "HTTP 302");

  const kps = await checkResolver("kps:203.0.113.10:15005:uEiB/keccak/19/4f", hash);
  assert.equal(kps.ok, true);
  assert.match(kps.detail, /not fetched here/);
});
