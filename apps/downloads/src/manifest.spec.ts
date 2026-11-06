import { assetsFor, downloadsUrl, isDownloads, type Asset, type Downloads } from "./manifest.ts";

const asset = (os: Asset["os"], arch: Asset["arch"], kind: Asset["kind"]): Asset => ({
  os,
  arch,
  kind,
  name: `${os}-${arch}.${kind}`,
  url: `https://example.org/${os}-${arch}.${kind}`,
  size: 1,
  sha256: null,
});

const client: Downloads = {
  schema: 1,
  id: "client",
  channel: "beta",
  version: "0.2.0-beta.6",
  date: "2026-11-04",
  notes: null,
  checksums: null,
  assets: [
    asset("linux", "x86_64", "rpm"),
    asset("linux", "x86_64", "AppImage"),
    asset("linux", "x86_64", "deb"),
    asset("macos", "universal", "dmg"),
    asset("windows", "x86_64", "exe"),
  ],
};

describe("assetsFor", () => {
  it("orders a platform's downloads, the most familiar first", () => {
    expect(assetsFor(client, { os: "linux", arch: "x86_64" }).map((a) => a.kind)).toEqual([
      "AppImage",
      "deb",
      "rpm",
    ]);
  });
  it("offers a universal build to every arch", () => {
    expect(assetsFor(client, { os: "macos", arch: "arm64" }).map((a) => a.kind)).toEqual(["dmg"]);
    expect(assetsFor(client, { os: "macos", arch: "unknown" }).map((a) => a.kind)).toEqual(["dmg"]);
  });
  it("takes an unknown arch as x86_64", () => {
    expect(assetsFor(client, { os: "windows", arch: "unknown" }).map((a) => a.kind)).toEqual([
      "exe",
    ]);
  });
  it("offers nothing where there is no build", () => {
    expect(assetsFor(client, { os: "windows", arch: "arm64" })).toEqual([]);
    expect(assetsFor(client, { os: "android", arch: "arm64" })).toEqual([]);
    expect(assetsFor(undefined, { os: "linux", arch: "x86_64" })).toEqual([]);
  });
});

describe("downloads.json", () => {
  it("lives at <base>/<id>/<channel>/downloads.json", () => {
    expect(downloadsUrl("https://example.org/updates/", "client-cli", "beta")).toBe(
      "https://example.org/updates/client-cli/beta/downloads.json",
    );
  });
  it("is used only when it is schema 1 for the component asked for", () => {
    expect(isDownloads(client, "client")).toBe(true);
    expect(isDownloads(client, "client-cli")).toBe(false);
    expect(isDownloads({ ...client, schema: 2 }, "client")).toBe(false);
    expect(isDownloads(null, "client")).toBe(false);
  });
});
