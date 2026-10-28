// Tiers, local config, the committed record, the Pages staging and prod's
// repository rules: the pure parts of the deploy cycle.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURE_BUNDLE, PROJECT_DIR } from "../scripts/lib/paths.mjs";
import {
  checkRecord,
  createdRecord,
  findRecord,
  readRecord,
  updatedRecord,
  writeRecord,
} from "../scripts/lib/record.mjs";
import {
  assertChain,
  expandResolvers,
  loadTierConfig,
  TIERS,
  tierOf,
} from "../scripts/lib/tiers.mjs";
import { nextRecord } from "../scripts/deploy.mjs";
import { prodRefusals } from "../scripts/preflight.mjs";
import { HEADERS, stage } from "../scripts/publish.mjs";

const H1 = "0x194f04bde4925f6bbb0bd8bdfceca7251125eaa0664ce3c0c25dce2a1545338d";
const H2 = `0x${"ab".repeat(32)}`;
const tmp = () => mkdtempSync(join(tmpdir(), "zknet-tiers-"));

test("tiers map to their chains, and an unknown tier is an error", () => {
  assert.equal(tierOf("dev").chainId, 31337);
  assert.equal(tierOf("test").chainId, 11155111);
  assert.equal(tierOf("prod").chainId, 1);
  assert.equal(TIERS.dev?.public, false);
  assert.throws(() => tierOf("staging"), /unknown tier staging/);
  assert.throws(() => tierOf(undefined), /unknown tier/);
});

test("a tier refuses another chain", () => {
  assert.doesNotThrow(() => assertChain(tierOf("test"), 11155111));
  assert.throws(() => assertChain(tierOf("test"), 1), /chain 1, but tier test is chain 11155111/);
  assert.throws(() => assertChain(tierOf("prod"), 11155111), /refusing/);
});

test("resolver templates expand to the content address", () => {
  assert.deepEqual(
    expandResolvers(["https://a.example/keccak/{path}", "https://b.example/{path}"], H1),
    [`https://a.example/keccak/19/${H1.slice(4)}`, `https://b.example/19/${H1.slice(4)}`],
  );
});

/** @param {unknown} section */
function configWith(section) {
  const file = join(tmp(), "deploy.local.json");
  writeFileSync(file, JSON.stringify({ test: section }));
  return file;
}

const GOOD = {
  rpcUrl: "https://rpc.example",
  account: "deployer",
  deployer: "0x00000000000000000000000000000000000000aa",
  resolvers: ["https://x.pages.dev/keccak/{path}"],
  pages: { project: "x" },
};

test("local config: a complete section loads", () => {
  const c = loadTierConfig(tierOf("test"), configWith(GOOD));
  assert.equal(c.account, "deployer");
  assert.deepEqual(c.pages, { project: "x" });
});

test("local config: missing file, missing section, placeholders and bad entries are refused", () => {
  const t = tierOf("test");
  assert.throws(() => loadTierConfig(t, join(tmp(), "none.json")), /not found/);
  assert.throws(() => loadTierConfig(tierOf("prod"), configWith(GOOD)), /no "prod" section/);
  assert.throws(
    () => loadTierConfig(t, configWith({ ...GOOD, account: "<keystore>" })),
    /account is not set/,
  );
  assert.throws(
    () => loadTierConfig(t, configWith({ ...GOOD, deployer: "0x12" })),
    /not an address/,
  );
  assert.throws(
    () => loadTierConfig(t, configWith({ ...GOOD, resolvers: ["https://x/keccak/"] })),
    /\{path\}/,
  );
  assert.throws(
    () => loadTierConfig(t, configWith({ ...GOOD, resolvers: ["http://x/{path}"] })),
    /https/,
  );
  assert.throws(() => loadTierConfig(t, configWith({ ...GOOD, resolvers: [] })), /non-empty/);
  const placeholder = { ...GOOD, resolvers: ["https://<pages project>.pages.dev/keccak/{path}"] };
  assert.throws(() => loadTierConfig(t, configWith(placeholder)), /placeholder/);
  // A caller with its own resolvers (dry run, rehearsal, verify) does not need the list yet.
  assert.deepEqual(loadTierConfig(t, configWith(placeholder), { resolvers: false }).resolvers, []);
});

test("the committed example config is valid JSON with test and prod sections, and is not ignored", () => {
  const example = JSON.parse(readFileSync(join(PROJECT_DIR, "deploy.local.example.json"), "utf8"));
  assert.ok(example.test && example.prod);
  // Placeholders must not pass as real values.
  const file = join(tmp(), "c.json");
  writeFileSync(file, JSON.stringify(example));
  assert.throws(() => loadTierConfig(tierOf("test"), file), /is not set/);
  const ignored = (/** @type {string} */ f) =>
    spawnSync("git", ["check-ignore", "-q", f], { cwd: PROJECT_DIR }).status === 0;
  assert.equal(ignored("deploy.local.json"), true, "the real config must be git-ignored");
  assert.equal(ignored("deploy.local.example.json"), false, "the example must be committable");
  assert.equal(ignored("deployments/test.json"), false, "the posted record must be committable");
  assert.equal(
    ignored(".state/records/test.json"),
    true,
    "the working record must stay out of git",
  );
});

const BUNDLE = { file: "w.js", bytes: 10, gitCommit: "c1", dirty: false };
const created = () =>
  createdRecord({
    tier: "test",
    chainId: 11155111,
    address: "0x00000000000000000000000000000000000000cc",
    codehash: "0xc4c5",
    owner: "0x00000000000000000000000000000000000000aa",
    creation: { tx: "0xt1", block: 1 },
    workerHash: H1,
    bundle: BUNDLE,
  });

test("record: no resolver URLs, ever", () => {
  assert.doesNotThrow(() => checkRecord(created()));
  assert.throws(() => checkRecord({ ...created(), resolvers: [] }), /resolvers do not belong/);
  assert.throws(
    () => checkRecord({ ...created(), bundle: { ...BUNDLE, file: "https://x.pages.dev/a" } }),
    /holds a URL/,
  );
  assert.throws(() => checkRecord({ ...created(), address: undefined }), /address missing/);
});

test("record: an update moves the top level and appends one history entry", () => {
  const next = updatedRecord(created(), {
    tx: "0xt2",
    block: 2,
    workerHash: H2,
    bundle: { ...BUNDLE, gitCommit: "c2" },
    owner: created().owner,
  });
  assert.equal(next.workerHash, H2);
  assert.equal(next.bundle.gitCommit, "c2");
  assert.deepEqual(next.creation, { tx: "0xt1", block: 1 });
  assert.deepEqual(next.updates, [{ tx: "0xt2", block: 2, workerHash: H2, gitCommit: "c2" }]);
});

test("record: a hand-curated history (missing, empty, pruned) changes nothing but the history", () => {
  const update = { tx: "0xt3", block: 3, workerHash: H2, bundle: BUNDLE, owner: created().owner };
  const { updates: _, ...withoutHistory } = created();
  for (const previous of [
    /** @type {any} */ (withoutHistory),
    { ...created(), updates: [] },
    { ...created(), updates: [{ tx: "0xold", block: 0, workerHash: H1, gitCommit: "c0" }] },
  ]) {
    const next = updatedRecord(previous, update);
    const { updates, ...top } = next;
    const { updates: __, ...expectedTop } = updatedRecord({ ...created(), updates: [] }, update);
    assert.deepEqual(top, expectedTop);
    assert.equal(updates?.at(-1)?.tx, "0xt3");
    assert.equal(updates?.length, (previous.updates?.length ?? 0) + 1);
  }
});

test("record: round-trips through a file, and nextRecord builds create and update", () => {
  const file = join(tmp(), "test.json");
  const tier = tierOf("test");
  const first = nextRecord(
    tier,
    11155111,
    { action: "created", address: created().address, tx: "0xt1", block: 1 },
    undefined,
    BUNDLE,
    H1,
    created().owner,
  );
  writeRecord(file, first);
  assert.deepEqual(readRecord(file), first);
  const second = nextRecord(
    tier,
    11155111,
    { action: "updated", address: first.address, tx: "0xt2", block: 2 },
    first,
    BUNDLE,
    H2,
    first.owner,
  );
  assert.equal(second.workerHash, H2);
  assert.equal(second.updates?.length, 1);
  assert.equal(readRecord(join(tmp(), "absent.json")), undefined);
});

test("publish staging is content-addressed, cumulative, and sets the resolver headers", async () => {
  const site = tmp();
  const other = join(tmp(), "other.js");
  writeFileSync(other, "// another worker\n");
  const one = await stage(FIXTURE_BUNDLE, site);
  assert.equal(one.workerHash, H1);
  assert.deepEqual(one.staged, [H1]);
  const two = await stage(other, site);
  assert.equal(two.staged.length, 2);
  assert.ok(two.staged.includes(H1), "an earlier bundle stays on the site");
  assert.ok(existsSync(join(site, "keccak/19", H1.slice(4))));
  assert.equal(readFileSync(join(site, "_headers"), "utf8"), HEADERS);
  assert.match(HEADERS, /no-transform/);
  assert.match(HEADERS, /application\/octet-stream/);
  assert.ok(existsSync(join(site, "404.html")));
});

test("publish staging refuses a corrupted site", async () => {
  const site = tmp();
  const other = join(tmp(), "other.js");
  writeFileSync(other, "// another worker\n");
  await stage(FIXTURE_BUNDLE, site);
  writeFileSync(join(site, "keccak/19", H1.slice(4)), "tampered");
  await assert.rejects(stage(other, site), /does not hash to its address/);
});

test("prod refuses a dirty tree, another branch, an unpushed HEAD, and a hash test does not pin", () => {
  const ok = {
    porcelain: "",
    branch: "main",
    remotes: ["r/main"],
    testWorkerHash: H1,
    workerHash: H1,
  };
  assert.deepEqual(prodRefusals(ok), []);
  assert.match(prodRefusals({ ...ok, porcelain: " M x" }).join(), /not clean/);
  assert.match(prodRefusals({ ...ok, branch: "work" }).join(), /not main/);
  assert.match(prodRefusals({ ...ok, remotes: [] }).join(), /no remote branch/);
  assert.match(prodRefusals({ ...ok, testWorkerHash: undefined }).join(), /does not exist/);
  assert.match(prodRefusals({ ...ok, testWorkerHash: H2 }).join(), /prod follows test/);
});

test("records: the working record wins over the posted one, and a differing posted one is reported", () => {
  const working = tmp();
  const posted = tmp();
  const at = (/** @type {string} */ a) => ({ ...created(), address: a });
  const A = "0x00000000000000000000000000000000000000a1";
  const B = "0x00000000000000000000000000000000000000b2";
  assert.deepEqual(findRecord("test", working, posted), {});

  writeRecord(join(posted, "test.json"), at(B));
  const onlyPosted = findRecord("test", working, posted);
  assert.equal(onlyPosted.record?.address, B);
  assert.equal(onlyPosted.file, join(posted, "test.json"));

  writeRecord(join(working, "test.json"), at(A));
  const both = findRecord("test", working, posted);
  assert.equal(both.record?.address, A);
  assert.equal(both.file, join(working, "test.json"));
  assert.equal(both.posted?.address, B, "a posted record naming another contract is surfaced");

  writeRecord(join(posted, "test.json"), at(A.toUpperCase().replace("0X", "0x")));
  assert.equal(
    findRecord("test", working, posted).posted,
    undefined,
    "same address: nothing to report",
  );
});

test("record: one started from --address has no creation, and still updates", () => {
  const { creation: _, ...noCreation } = created();
  assert.doesNotThrow(() => checkRecord(noCreation));
  const tier = tierOf("test");
  const adopted = nextRecord(
    tier,
    11155111,
    { action: "noop", address: created().address },
    undefined,
    BUNDLE,
    H1,
    created().owner,
  );
  assert.equal(adopted.creation, undefined);
  assert.equal(adopted.workerHash, H1);
  assert.deepEqual(adopted.updates, []);
  const updated = nextRecord(
    tier,
    11155111,
    { action: "updated", address: created().address, tx: "0xt9", block: 9 },
    undefined,
    BUNDLE,
    H2,
    created().owner,
  );
  assert.equal(updated.workerHash, H2);
  assert.equal(updated.creation, undefined);
  assert.equal(updated.updates?.length, 1);
  assert.doesNotThrow(() => checkRecord(updated));
});
