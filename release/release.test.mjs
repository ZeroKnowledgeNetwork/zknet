// release.mjs refuses a components.json it would misread, and the desktop's
// release configuration embeds the committed updater key: run as
// `pnpm nx run release:test`. Each case runs a copy of release.mjs in a root
// of its own.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const real = JSON.parse(readFileSync(join(here, "components.json"), "utf8"));
const T = mkdtempSync(join(tmpdir(), "release-test-"));
after(() => rmSync(T, { recursive: true, force: true }));

const committedKey = join(here, "../libs/client-core/updater-key.pub");

// release.mjs ARGS in a root with COMPONENTS and, unless null, PUBKEY as its
// updater-key.pub, after SETUP(root) if given: { root, status, stdout, stderr }
function run(
  args,
  { components = real, pubkey = readFileSync(committedKey, "utf8"), env, setup } = {},
) {
  const root = mkdtempSync(join(T, "root-"));
  setup?.(root);
  mkdirSync(join(root, "release"));
  cpSync(join(here, "release.mjs"), join(root, "release/release.mjs"));
  writeFileSync(join(root, "release/components.json"), JSON.stringify(components));
  if (pubkey !== null) {
    mkdirSync(join(root, "libs/client-core"), { recursive: true });
    writeFileSync(join(root, "libs/client-core/updater-key.pub"), pubkey);
  }
  const argv = args.map((a) => a.replace("{root}", root));
  const r = spawnSync("node", [join(root, "release/release.mjs"), ...argv], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { root, ...r };
}
const parse = (components) => run(["parse", "client@1.0.0"], { components });
const client = (change) => ({ ...real, client: change({ ...real.client }) });

test("the committed components.json is valid", () => {
  const out = execFileSync("node", [join(here, "release.mjs"), "parse", "client@1.0.0"], {
    encoding: "utf8",
  });
  assert.equal(JSON.parse(out).id, "client");
});

test("a misspelt key fails loudly, naming it", () => {
  const r = parse(
    client((c) => {
      delete c.latest;
      return { ...c, lastest: true };
    }),
  );
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /^release\.mjs: release\/components\.json: "client" has an unknown key "lastest"; known: project, paths, excludePaths, cargo, runners, manifest, latest\n$/,
  );
  assert.equal(r.stdout, "");
});

test("a missing required key fails", () => {
  const r = parse(
    client((c) => {
      delete c.cargo;
      return c;
    }),
  );
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'release.mjs: release/components.json: "client" has no "cargo"\n');
});

test("a value of the wrong kind fails", () => {
  const cases = [
    [(c) => ({ ...c, manifest: "true" }), '"manifest" must be true or false'],
    [
      (c) => ({ ...c, runners: ["linux", "freebsd"] }),
      '"runners" must be a non-empty array of linux, macos, windows',
    ],
    [(c) => ({ ...c, paths: "apps/client/**" }), '"paths" must be an array of strings'],
    [(c) => ({ ...c, project: "" }), '"project" must be a non-empty string'],
  ];
  for (const [change, why] of cases) {
    const r = parse(client(change));
    assert.equal(r.status, 1, why);
    assert.equal(r.stderr, `release.mjs: release/components.json: "client": ${why}\n`);
  }
});

test("only one component can be latest", () => {
  const r = parse({ ...real, "client-cli": { ...real["client-cli"], latest: true } });
  assert.equal(r.status, 1);
  assert.equal(
    r.stderr,
    'release.mjs: release/components.json: only one component can be "latest"\n',
  );
});

test("the optional keys may be absent", () => {
  const r = parse(
    client((c) => {
      delete c.manifest;
      delete c.latest;
      return c;
    }),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).manifest, undefined);
});

// the desktop's release configuration (client:desktop-build:release)
function tauriConfig(opts) {
  const r = run(["tauri-config", "{root}/out/tauri.json"], {
    ...opts,
    env: { ZKNET_TAG: "client@1.2.3", ...opts?.env },
  });
  const file = join(r.root, "out/tauri.json");
  return { ...r, config: r.status === 0 ? JSON.parse(readFileSync(file, "utf8")) : undefined };
}

test("tauri-config embeds the committed updater key, whatever the environment says", () => {
  const { status, stderr, config } = tauriConfig({ env: { ZKNET_UPDATER_PUBKEY: "not-this-one" } });
  assert.equal(status, 0, stderr);
  assert.equal(config.plugins.updater.pubkey, readFileSync(committedKey, "utf8").trim());
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.equal(config.version, "1.2.3");
  assert.match(
    Buffer.from(config.plugins.updater.pubkey, "base64").toString(),
    /^untrusted comment: minisign public key: [0-9A-F]{16}\n/,
  );
});

test("tauri-config takes the endpoint from ZKNET_UPDATER_ENDPOINT", () => {
  const { config } = tauriConfig({
    env: { ZKNET_UPDATER_ENDPOINT: "https://example.test/latest.json" },
  });
  assert.deepEqual(config.plugins.updater.endpoints, ["https://example.test/latest.json"]);
});

test("tauri-config refuses without the key file, or with something else in it", () => {
  const none = tauriConfig({ pubkey: null });
  assert.equal(none.status, 1);
  assert.equal(
    none.stderr,
    "release.mjs: no libs/client-core/updater-key.pub: the desktop updater's public key\n",
  );
  for (const bad of [
    "",
    "RWRCdY7xqyR38Obpt11MXpLWOd1NQl25bYKCOqVoVr+aNyWuAWzIPAxi\n",
    "not base64 at all",
  ]) {
    const r = tauriConfig({ pubkey: bad });
    assert.equal(r.status, 1, JSON.stringify(bad));
    assert.match(r.stderr, /is not a Tauri updater public key/);
  }
});

test("a prerelease bundles everything but the .rpm", () => {
  const conf = { bundle: { targets: ["deb", "rpm", "appimage", "nsis", "app", "dmg"] } };
  const withConf = (env) =>
    tauriConfig({
      env,
      setup: (root) => {
        mkdirSync(join(root, "apps/client/src-tauri"), { recursive: true });
        writeFileSync(join(root, "apps/client/src-tauri/tauri.conf.json"), JSON.stringify(conf));
      },
    });
  const pre = withConf({ ZKNET_TAG: "client@1.2.3-beta.0" });
  assert.equal(pre.status, 0, pre.stderr);
  assert.deepEqual(pre.config.bundle.targets, ["deb", "appimage", "nsis", "app", "dmg"]);
  const stable = withConf({ ZKNET_TAG: "client@1.2.3" });
  assert.equal(stable.config.bundle.targets, undefined);
});

test("a dev build makes no updater artifacts", () => {
  const dev = JSON.parse(
    readFileSync(join(here, "../apps/client/src-tauri/tauri.dev.conf.json"), "utf8"),
  );
  assert.equal(dev.bundle.createUpdaterArtifacts, false);
});
