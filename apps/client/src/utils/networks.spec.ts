import {
  BADGES,
  NetworkRow,
  Listing,
  anyListed,
  autoFillId,
  caption,
  createdTitle,
  statusHint,
} from './networks';

const row = (
  id: string,
  status: NetworkRow['status'],
  extra: Partial<NetworkRow> = {},
): NetworkRow => ({
  id,
  status,
  entry: { id, kind: 'devnet', name: `Devnet · ${id}`, created: '2026-10-24T07:18:14Z' },
  origin: null,
  originLabel: null,
  createdAgo: '11 hours ago',
  ...extra,
});

const listing = (networks: NetworkRow[], sourceLabel: string | null = null): Listing => ({
  source: sourceLabel ? `http://${sourceLabel}` : 'https://built-in.example',
  sourceLabel,
  networks,
  indexError: null,
});

describe('network list presentation', () => {
  it('captions the built-in source without naming it', () => {
    expect(caption(listing([]))).toBe('Mix Networks');
    expect(caption(listing([], '127.0.0.1:8765'))).toBe('Mix Networks at 127.0.0.1:8765');
  });

  it('never names the built-in source for an other-source copy', () => {
    expect(statusHint(row('devnet-1', 'otherSource'))).toBe(
      "Downloaded from the default source, which isn't the current source",
    );
    expect(statusHint(row('lab-1', 'otherSource', { originLabel: '10.0.0.2:8765' }))).toContain(
      '10.0.0.2:8765',
    );
  });

  it('has a badge and a hint for every status', () => {
    for (const status of ['ready', 'available', 'cached', 'unlisted', 'otherSource'] as const) {
      expect(BADGES[status].label).not.toBe('');
      expect(statusHint(row('x', status))).not.toBe('');
    }
    // live is the theme's green (accent); success is blue in zkn-dark
    expect(BADGES.ready.className).toContain('badge-accent');
    expect(BADGES.available.className).toContain('badge-accent');
  });

  it('fills in the top row only when it is live and nothing is chosen', () => {
    const live = listing([row('devnet-2', 'available'), row('devnet-1', 'ready')]);
    expect(autoFillId(live, '')).toBe('devnet-2');
    expect(autoFillId(live, 'typed')).toBeNull();
    expect(autoFillId(listing([row('old', 'unlisted')]), '')).toBeNull();
    expect(autoFillId(listing([]), '')).toBeNull();
  });

  it('knows when nothing is listed, whatever is on this device', () => {
    expect(anyListed(listing([]))).toBe(false);
    expect(anyListed(listing([row('old', 'unlisted'), row('x', 'otherSource')]))).toBe(false);
    expect(anyListed(listing([row('old', 'unlisted'), row('new', 'available')]))).toBe(true);
  });

  it('titles CREATED with the full time in the given locale', () => {
    const title = createdTitle(row('devnet-1', 'ready'), 'en-US');
    expect(title).toContain('October');
    expect(title).toContain('2026');
    expect(createdTitle(row('x', 'unlisted', { entry: null }))).toBeUndefined();
  });
});
