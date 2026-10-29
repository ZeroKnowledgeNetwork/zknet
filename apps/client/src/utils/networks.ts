// The network list as zknet_client_core::network serializes it, and how it is shown.
// Status and sorting are decided in Rust; this file only presents them.

export type Status = "ready" | "available" | "cached" | "unpublished";

export type IndexEntry = { id: string; kind: string; name: string; created: string };

export type NetworkRow = {
  id: string;
  status: Status;
  entry: IndexEntry | null;
  source: string; // where it connects (full URL)
  sourceLabel: string | null; // its host; null for the built-in source, which is never shown
  createdAgo: string | null; // "11 hours ago", as docker ps writes CREATED
};

export type SourceError = { source: string; sourceLabel: string | null; error: string };

export type Listing = {
  launchSource: string;
  launchLabel: string | null; // null for the built-in source
  networks: NetworkRow[]; // published at the launch source first, then elsewhere; newest first
  unreachable: SourceError[]; // known sources whose index couldn't be read
};

export type Prepared = {
  dir: string;
  source: string;
  sourceLabel: string | null;
  build: string | null; // the signed build that runs; null if unsigned (dev-local only)
};

export const isLive = (n: NetworkRow) => n.status === "ready" || n.status === "available";

type Badge = { label: string; className: string; dot: string };

// daisyUI 5 classes. In the zkn-dark theme `accent` is the green and `success`
// is blue, so live is accent; soft info/neutral badges are illegible on base-200.
export const BADGES: Record<Status, Badge> = {
  ready: { label: "Ready", className: "badge-soft badge-accent", dot: "status-accent" },
  available: { label: "Available", className: "badge-soft badge-accent", dot: "status-accent" },
  cached: { label: "Cached", className: "badge-soft badge-warning", dot: "status-warning" },
  unpublished: { label: "Unpublished", className: "badge-ghost", dot: "status-error" },
};

// The badge's tooltip. The built-in source is never named.
export const statusHint = (n: NetworkRow): string => {
  switch (n.status) {
    case "ready":
      return "Published, and already downloaded: connects without a download";
    case "available":
      return "Published; its client is downloaded when you connect";
    case "cached":
      return "On this device; its source couldn't be reached, so it may or may not be running";
    case "unpublished":
      return "On this device, but no longer published: it has probably stopped";
  }
};

// "Mix Networks", plus where from only when launched at a source that isn't the built-in one
export const caption = (l: Listing) =>
  l.launchLabel ? `Mix Networks at ${l.launchLabel}` : "Mix Networks";

// The warning for a source that couldn't be read; the built-in one is never named
export const unreachableText = (e: SourceError) =>
  e.sourceLabel
    ? `Couldn't reach ${e.sourceLabel}. Its networks are shown from this device.`
    : "Couldn't reach the network list. Showing networks on this device.";

// A Source column only once a source other than the built-in one is known; its
// cells stay blank for the built-in source, which is never shown
export const showsSource = (l: Listing) => l.networks.some((n) => n.sourceLabel !== null);

// Whether any known source publishes a network now
export const anyListed = (l: Listing) => l.networks.some(isLive);

// The network to fill in: the top row when it is live and nothing is chosen
export const autoFillId = (l: Listing, chosen: string): string | null =>
  chosen === "" && l.networks.length > 0 && isLive(l.networks[0]) ? l.networks[0].id : null;

// The full created time in the user's locale, for the CREATED tooltip
export const createdTitle = (n: NetworkRow, locale?: string) =>
  n.entry && !Number.isNaN(Date.parse(n.entry.created))
    ? new Date(n.entry.created).toLocaleString(locale, { dateStyle: "full", timeStyle: "long" })
    : undefined;
