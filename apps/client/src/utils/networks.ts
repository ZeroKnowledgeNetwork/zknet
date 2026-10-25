// The network list as zknet_core::network serializes it, and how it is shown.
// Status and sorting are decided in Rust; this file only presents them.

export type Status = 'ready' | 'available' | 'cached' | 'unlisted' | 'otherSource';

export type IndexEntry = { id: string; kind: string; name: string; created: string };

export type NetworkRow = {
  id: string;
  status: Status;
  entry: IndexEntry | null;
  origin: string | null; // the source of the copy on disk (full URL)
  originLabel: string | null; // its host; null for the built-in source, which is never shown
  createdAgo: string | null; // "11 hours ago", as docker ps writes CREATED
};

export type Listing = {
  source: string;
  sourceLabel: string | null; // null for the built-in source
  networks: NetworkRow[]; // live first, newest first
  indexError: string | null;
};

export type Prepared = {
  dir: string;
  origin: string;
  originLabel: string | null;
  otherSource: boolean;
};

export const isLive = (n: NetworkRow) => n.status === 'ready' || n.status === 'available';

type Badge = { label: string; className: string; dot: string };

// daisyUI 5 classes. In the zkn-dark theme `accent` is the green and `success`
// is blue, so live is accent; soft info/neutral badges are illegible on base-200.
export const BADGES: Record<Status, Badge> = {
  ready: { label: 'Ready', className: 'badge-soft badge-accent', dot: 'status-accent' },
  available: { label: 'Available', className: 'badge-soft badge-accent', dot: 'status-accent' },
  cached: { label: 'Cached', className: 'badge-soft badge-warning', dot: 'status-warning' },
  unlisted: { label: 'Unlisted', className: 'badge-ghost', dot: 'status-error' },
  otherSource: { label: 'Other source', className: 'badge-outline', dot: 'status-secondary' },
};

// The badge's tooltip. The built-in source is never named.
export const statusHint = (n: NetworkRow): string => {
  switch (n.status) {
    case 'ready':
      return 'Listed now, and already downloaded: connects without a download';
    case 'available':
      return 'Listed now; its client is downloaded when you connect';
    case 'cached':
      return "On this device; the network list couldn't be reached, so it may or may not be running";
    case 'unlisted':
      return 'On this device, but no longer in the network list: it has probably stopped';
    case 'otherSource':
      return `Downloaded from ${n.originLabel ?? 'the default source'}, which isn't the current source`;
  }
};

// "Mix Networks", plus where from only when the source isn't the built-in one
export const caption = (l: Listing) =>
  l.sourceLabel ? `Mix Networks at ${l.sourceLabel}` : 'Mix Networks';

// Whether the source lists any network now
export const anyListed = (l: Listing) => l.networks.some(isLive);

// The network to fill in: the top row when it is live and nothing is chosen
export const autoFillId = (l: Listing, chosen: string): string | null =>
  chosen === '' && l.networks.length > 0 && isLive(l.networks[0]) ? l.networks[0].id : null;

// The full created time in the user's locale, for the CREATED tooltip
export const createdTitle = (n: NetworkRow, locale?: string) =>
  n.entry && !Number.isNaN(Date.parse(n.entry.created))
    ? new Date(n.entry.created).toLocaleString(locale, { dateStyle: 'full', timeStyle: 'long' })
    : undefined;
