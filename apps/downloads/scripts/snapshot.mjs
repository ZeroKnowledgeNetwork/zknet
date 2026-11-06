#!/usr/bin/env node
// Bake the fallback: copy the current downloads.json of each component the
// page offers into public/downloads/<id>/<channel>/, which the page reads when
// VITE_DOWNLOADS_BASE does not answer. Runs on the build machine, never in a
// visitor's browser. Settings: .env (.env.example); the environment wins.
//
//   node scripts/snapshot.mjs
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const base = (process.env.VITE_DOWNLOADS_BASE ?? "").trim().replace(/\/$/, "");
const channel = (process.env.VITE_CHANNEL ?? "").trim() || "beta";
const components = ["client", "client-cli"]; // src/manifest.ts COMPONENTS
const out = join(root, "public/downloads");

await rm(out, { recursive: true, force: true });
if (!base) {
  console.log("snapshot: VITE_DOWNLOADS_BASE is empty: no fallback baked");
  process.exit(0);
}
for (const id of components) {
  const url = `${base}/${id}/${channel}/downloads.json`;
  const res = await fetch(url);
  if (res.status === 404) {
    console.log(`snapshot: ${id}: no release on ${channel}`);
    continue;
  }
  if (!res.ok) throw new Error(`snapshot: ${url}: HTTP ${res.status}`);
  const d = await res.json();
  if (d?.schema !== 1 || d.id !== id || !Array.isArray(d.assets))
    throw new Error(`snapshot: ${url}: not a schema 1 downloads.json for ${id}`);
  const file = join(out, id, channel, "downloads.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(d, null, 2)}\n`);
  console.log(`snapshot: ${id}@${d.version} (${channel}, ${d.assets.length} assets)`);
}
