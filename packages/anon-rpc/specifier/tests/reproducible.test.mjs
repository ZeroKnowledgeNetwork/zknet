// The reproducibility checker, driven with stand-in build commands: one that
// is deterministic and one that embeds the time, which must be caught.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { test } from "node:test";
import { FIXTURE_BUNDLE, PROJECT_DIR, WORKSPACE_DIR } from "../scripts/lib/paths.mjs";
import { firstDifference } from "../scripts/reproducible.mjs";

const SCRIPT = join(PROJECT_DIR, "scripts/reproducible.mjs");
const OUT = join(PROJECT_DIR, ".state/repro-test/bundle.js");
const out = relative(WORKSPACE_DIR, OUT);

/** @param {string} build */
function check(build) {
  return spawnSync(process.execPath, [SCRIPT, "--bundle", OUT, "--build", build], {
    encoding: "utf8",
  });
}

test("byte-identical builds pass", () => {
  const r = check(
    `mkdir -p $(dirname ${out}) && cp ${relative(WORKSPACE_DIR, FIXTURE_BUNDLE)} ${out}`,
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /✓ reproducible: 2 builds .* are byte-identical \(keccak256 0x194f04bd/);
});

test("a build that embeds the time is caught, with the first differing byte", () => {
  const r = check(`mkdir -p $(dirname ${out}) && echo "// built $(date +%s%N)" > ${out}`);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /✗ NOT reproducible: .* differs from run 1 at byte \d+/);
});

test("a build that produces nothing fails loudly", () => {
  const r = check("true");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /did not produce/);
});

test("firstDifference", () => {
  assert.equal(firstDifference(Buffer.from("abc"), Buffer.from("abc")), -1);
  assert.equal(firstDifference(Buffer.from("abc"), Buffer.from("abd")), 2);
  assert.equal(firstDifference(Buffer.from("ab"), Buffer.from("abc")), 2);
});

test("--clean-export --ref WORKTREE exports uncommitted files and catches a path leak", () => {
  // This test file itself may be uncommitted; the export must still hold it.
  const self = relative(WORKSPACE_DIR, join(PROJECT_DIR, "tests/reproducible.test.mjs"));
  const base = ["--bundle", OUT, "--clean-export", "--ref", "WORKTREE", "--install", "true"];
  const run = (/** @type {string} */ build) =>
    spawnSync(process.execPath, [SCRIPT, ...base, "--build", build], { encoding: "utf8" });

  const same = run(`mkdir -p $(dirname ${out}) && cp ${self} ${out}`);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.match(same.stdout, /clean export of WORKTREE/);

  const leaky = run(`mkdir -p $(dirname ${out}) && pwd > ${out}`);
  assert.equal(leaky.status, 1, leaky.stdout + leaky.stderr);
});
