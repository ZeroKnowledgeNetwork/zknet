// release.mjs refuses a components.json it would misread: run as
// `pnpm nx run release:test`. Each case runs a copy of release.mjs beside its
// own components.json.
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

// release.mjs parse client@1.0.0 against COMPONENTS: { status, stdout, stderr }
function parse(components) {
  const root = mkdtempSync(join(T, "root-"));
  mkdirSync(join(root, "release"));
  cpSync(join(here, "release.mjs"), join(root, "release/release.mjs"));
  writeFileSync(join(root, "release/components.json"), JSON.stringify(components));
  return spawnSync("node", [join(root, "release/release.mjs"), "parse", "client@1.0.0"], {
    encoding: "utf8",
  });
}
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
  const r = parse(client(({ cargo, ...c }) => c));
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
  const r = parse(client(({ manifest, latest, ...c }) => c));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).manifest, undefined);
});
