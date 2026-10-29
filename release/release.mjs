#!/usr/bin/env node
// Release helpers shared by .github/workflows/release.yml and the .woodpecker
// pipelines. Everything a component's release needs is derived from its tag,
// <id>@<semver>, and release/components.json, keyed by <id>: renaming a
// component's tag prefix is a one-line change there. See release/README.md.
//
//   release.mjs parse TAG              the component as JSON
//   release.mjs gha-outputs TAG        the same as GitHub Actions step outputs
//   release.mjs wanted PROJECT         exit 0 if this build includes the Nx project
//   release.mjs id PROJECT             the Nx project's tag prefix
//   release.mjs version [TAG]          the tag's version
//   release.mjs stamp                  write the tag's version into the component's manifests
//   release.mjs notes TAG              the release notes (git-cliff, cliff.toml)
//   release.mjs tauri-config FILE      write the desktop release build's Tauri configuration
//   release.mjs manifest TAG DIR       the desktop updater's latest.json from the assets in DIR
//
// The tag comes from the argument, else ZKNET_TAG, else CI_COMMIT_TAG
// (Woodpecker). No tag means a development build: every project is wanted and
// nothing is stamped.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const components = JSON.parse(readFileSync(join(root, "release/components.json"), "utf8"));

// semver 2.0.0, without build metadata: a rebuild is a new version
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

function die(message) {
  console.error(`release.mjs: ${message}`);
  process.exit(1);
}

function currentTag(arg) {
  return arg || process.env.ZKNET_TAG || process.env.CI_COMMIT_TAG || "";
}

function parse(tag) {
  const at = tag.indexOf("@");
  if (at < 1) die(`not a component tag (<id>@<semver>): ${tag}`);
  const id = tag.slice(0, at);
  const version = tag.slice(at + 1);
  const component = components[id];
  if (!component)
    die(`unknown component "${id}" in ${tag}; known: ${Object.keys(components).join(", ")}`);
  if (!SEMVER.test(version)) die(`not a semver version (no +build): ${version}`);
  return { tag, id, version, prerelease: version.includes("-"), ...component };
}

function stamp(tag) {
  if (!tag) return console.error("stamp: no tag, nothing to stamp");
  const c = parse(tag);
  for (const manifest of c.cargo) {
    const path = join(root, manifest);
    const text = readFileSync(path, "utf8");
    // the first `version =` is [package]'s (the manifests keep it first)
    const stamped = text.replace(/^version = ".*"$/m, `version = "${c.version}"`);
    if (stamped === text && !text.includes(`version = "${c.version}"`))
      die(`no version line in ${manifest}`);
    writeFileSync(path, stamped);
    console.error(`stamp: ${manifest} = ${c.version}`);
  }
  // keep Cargo.lock in step, or `cargo … --locked` refuses the build
  if (c.cargo.length)
    execFileSync("cargo", ["update", "--workspace"], { cwd: root, stdio: "inherit" });
}

function previousTag(c) {
  // the newest earlier tag of the same component (anchored: `cli@` never matches `client@`)
  const tags = execFileSync("git", ["tag", "--list", `${c.id}@*`, "--sort=-version:refname"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "versionsort.suffix",
      GIT_CONFIG_VALUE_0: "-",
    },
  })
    .split("\n")
    .filter((t) => t && t !== c.tag && SEMVER.test(t.slice(c.id.length + 1)));
  return tags[0];
}

function notes(tag) {
  const c = parse(tag);
  const prev = previousTag(c);
  const args = [
    "--config",
    join(root, "cliff.toml"),
    "--strip",
    "all",
    "--tag-pattern",
    `^${c.id}@`,
    "--tag",
    c.tag,
  ];
  for (const p of c.paths) args.push("--include-path", p);
  for (const p of c.excludePaths) args.push("--exclude-path", p);
  // a range plus --tag: --latest alone renders "unreleased" when the tagged
  // commit is outside the include-path. A first release takes the whole history.
  if (prev) args.push(`${prev}..${tagExists(c.tag) ? c.tag : "HEAD"}`);
  return execFileSync("git-cliff", args, { cwd: root, encoding: "utf8" });
}

function tagExists(tag) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function tauriConfig(tag) {
  const config = { plugins: { updater: {} }, bundle: {} };
  if (tag) config.version = parse(tag).version;
  const {
    ZKNET_UPDATER_PUBKEY: pubkey,
    ZKNET_UPDATER_ENDPOINT: endpoint,
    TAURI_SIGNING_PRIVATE_KEY: key,
  } = process.env;
  if (pubkey) config.plugins.updater.pubkey = pubkey;
  if (endpoint) config.plugins.updater.endpoints = [endpoint];
  if (!key) {
    // no signing key (a development build or a dispatch run): no updater artifacts
    config.bundle.createUpdaterArtifacts = false;
  } else if (!pubkey) {
    die(
      "TAURI_SIGNING_PRIVATE_KEY is set but ZKNET_UPDATER_PUBKEY is not: clients could not verify the update",
    );
  }
  return JSON.stringify(config);
}

// The Tauri updater's static manifest. Each platform points at its signed
// bundle in this release; the universal macOS bundle serves both darwin keys.
function manifest(tag, dir) {
  const c = parse(tag);
  const repo = process.env.GITHUB_REPOSITORY || die("manifest: GITHUB_REPOSITORY is not set");
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const assets = readdirSync(dir);
  const url = (asset) =>
    `${server}/${repo}/releases/download/${encodeURIComponent(c.tag)}/${encodeURIComponent(asset)}`;
  const entry = (suffix) => {
    const asset = assets.find((a) => a.endsWith(suffix));
    if (!asset) return undefined;
    if (!assets.includes(`${asset}.sig`)) die(`manifest: ${asset} has no .sig`);
    return { signature: readFileSync(join(dir, `${asset}.sig`), "utf8").trim(), url: url(asset) };
  };
  const platforms = {};
  const darwin = entry(".app.tar.gz");
  const linux = entry(".AppImage");
  const windows = entry("-setup.exe");
  if (darwin) platforms["darwin-aarch64"] = platforms["darwin-x86_64"] = darwin;
  if (linux) platforms["linux-x86_64"] = linux;
  if (windows) platforms["windows-x86_64"] = windows;
  if (!Object.keys(platforms).length) die(`manifest: no signed updater bundles in ${dir}`);
  return JSON.stringify(
    { version: c.version, notes: "", pub_date: new Date().toISOString(), platforms },
    null,
    2,
  );
}

function wanted(project) {
  const tag = currentTag();
  if (!tag) return true;
  return parse(tag).project === project;
}

const [cmd, a, b] = process.argv.slice(2);
switch (cmd) {
  case "parse":
    console.log(JSON.stringify(parse(currentTag(a))));
    break;
  case "gha-outputs": {
    const c = parse(currentTag(a));
    const out = [
      `id=${c.id}`,
      `version=${c.version}`,
      `project=${c.project}`,
      `prerelease=${c.prerelease}`,
    ];
    for (const r of ["linux", "macos", "windows"]) out.push(`${r}=${c.runners.includes(r)}`);
    console.log(out.join("\n"));
    break;
  }
  case "version":
    console.log(parse(currentTag(a)).version);
    break;
  case "id": {
    const id = Object.keys(components).find((k) => components[k].project === a);
    if (!id) die(`no component for the Nx project ${a}`);
    console.log(id);
    break;
  }
  case "wanted":
    if (!a) die("usage: wanted PROJECT");
    process.exit(wanted(a) ? 0 : 1);
  case "stamp":
    stamp(currentTag(a));
    break;
  case "notes":
    process.stdout.write(notes(currentTag(a)));
    break;
  case "tauri-config": {
    if (!a) die("usage: tauri-config FILE");
    mkdirSync(dirname(a), { recursive: true });
    writeFileSync(a, `${tauriConfig(currentTag())}\n`);
    break;
  }
  case "manifest":
    if (!b) die("usage: manifest TAG DIR");
    console.log(manifest(a, b));
    break;
  default:
    die(
      `usage: release.mjs parse|gha-outputs|wanted|id|version|stamp|notes|tauri-config|manifest …`,
    );
}
