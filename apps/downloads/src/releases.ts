// Each component's current release: its downloads.json, or the copy
// the build baked into this site when that does not answer.
import { config } from "./config.ts";
import {
  COMPONENTS,
  downloadsUrl,
  isDownloads,
  type Downloads,
  type Releases,
} from "./manifest.ts";

async function fetchDownloads(url: string, id: string): Promise<Downloads | undefined> {
  try {
    const res = await fetch(url, { cache: "no-cache", referrerPolicy: "no-referrer" });
    if (!res.ok) return undefined;
    const d: unknown = await res.json();
    return isDownloads(d, id) ? d : undefined;
  } catch {
    return undefined;
  }
}

export async function loadReleases(): Promise<Releases> {
  const { downloadsBase, channel } = config;
  const entries = await Promise.all(
    COMPONENTS.map(async (id) => {
      const live = downloadsBase
        ? await fetchDownloads(downloadsUrl(downloadsBase, id, channel), id)
        : undefined;
      return [
        id,
        live ?? (await fetchDownloads(downloadsUrl("/downloads", id, channel), id)),
      ] as const;
    }),
  );
  return Object.fromEntries(entries.filter(([, d]) => d));
}
