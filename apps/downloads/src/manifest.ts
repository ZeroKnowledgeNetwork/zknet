// downloads.json: one file per component and channel, at
// <VITE_DOWNLOADS_BASE>/<id>/<channel>/downloads.json, naming every installable
// asset of the component's current release on that channel. The page reads
// the desktop client's and the CLI's; install.sh reads the CLI's.
import type { Platform } from "./detect.ts";

export type Asset = {
  os: "windows" | "macos" | "linux";
  arch: "x86_64" | "arm64" | "universal";
  // dmg, exe (an installer), AppImage, deb, rpm, binary (a bare executable),
  // archive (.tar.xz or .zip)
  kind: "dmg" | "exe" | "AppImage" | "deb" | "rpm" | "binary" | "archive";
  name: string; // the release asset's file name
  url: string; // where to download it
  size: number; // bytes
  sha256: string | null; // from the release's checksums.txt; null if it lists none
};

export type Downloads = {
  schema: 1;
  id: string; // the component: client, client-cli, …
  channel: string; // stable | beta
  version: string; // semver, without the id@ prefix
  date: string; // the release's publish date, YYYY-MM-DD
  notes: string | null; // the release's page
  checksums: string | null; // the release's checksums.txt
  assets: Asset[];
};

export const COMPONENTS = ["client", "client-cli"] as const;
export type ComponentId = (typeof COMPONENTS)[number];
export type Releases = Partial<Record<ComponentId, Downloads>>;

export const downloadsUrl = (base: string, id: string, channel: string) =>
  `${base.replace(/\/$/, "")}/${id}/${channel}/downloads.json`;

// A file the page can use: schema 1, the component asked for, assets an array
export function isDownloads(value: unknown, id: string): value is Downloads {
  const d = value as Downloads;
  return (
    !!d && d.schema === 1 && d.id === id && typeof d.version === "string" && Array.isArray(d.assets)
  );
}

// The order a platform prefers its downloads in, most familiar first
const PREFERENCE: Asset["kind"][] = ["dmg", "exe", "AppImage", "deb", "rpm", "binary", "archive"];

export function assetsFor(d: Downloads | undefined, { os, arch }: Platform): Asset[] {
  if (!d) return [];
  const want = (a: Asset) =>
    a.os === os &&
    (a.arch === "universal" || a.arch === arch || (arch === "unknown" && a.arch === "x86_64"));
  return d.assets
    .filter(want)
    .sort((a, b) => PREFERENCE.indexOf(a.kind) - PREFERENCE.indexOf(b.kind));
}

export const mb = (bytes: number) =>
  `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
