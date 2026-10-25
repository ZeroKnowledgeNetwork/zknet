import { IconArrowPath } from './icons';
import {
  BADGES,
  Listing,
  NetworkRow,
  anyListed,
  caption,
  createdTitle,
  statusHint,
  unreachableText,
} from '../utils/networks';

function StatusBadge({ row }: { row: NetworkRow }) {
  const badge = BADGES[row.status];
  return (
    <span
      className={`badge badge-sm gap-1.5 whitespace-nowrap ${badge.className}`}
      title={statusHint(row)}
    >
      <span aria-hidden className={`status status-sm ${badge.dot}`} />
      {badge.label}
    </span>
  );
}

// The reload button rests with the network-id input's subdued outline (daisyUI's
// --input-color: base-content at 20%) and brightens on hover. `!` is needed:
// Tailwind declares its utilities layer before daisyUI's, so .btn's own border
// would otherwise win.
export const RELOAD_BUTTON =
  'btn btn-sm btn-square btn-ghost border-base-content/20! hover:border-base-content/70! hover:bg-base-300!';

export function NetworkTable(props: {
  listing: Listing;
  selected: string;
  loading: boolean;
  onSelect: (id: string) => void;
  onReload: () => void;
}) {
  const { listing, selected } = props;
  return (
    <div className="w-full max-w-2xl rounded-box border border-base-300 bg-base-200">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-sm opacity-70">{caption(listing)}</span>
        <button
          type="button"
          className={RELOAD_BUTTON}
          onClick={props.onReload}
          disabled={props.loading}
          title="Reload the network list"
          aria-label="Reload the network list"
        >
          {props.loading ? (
            <span className="loading loading-spinner loading-sm" />
          ) : (
            <IconArrowPath className="size-4" />
          )}
        </button>
      </div>
      {listing.unreachable.map((e) => (
        <div
          key={e.source}
          role="alert"
          className="alert alert-soft alert-warning mx-3 mb-2 py-2 text-sm"
          title={e.error}
        >
          {unreachableText(e)}
        </div>
      ))}
      {listing.unreachable.length === 0 && !anyListed(listing) && (
        <p className="px-3 pb-4 pt-1 text-sm opacity-60">No listed networks.</p>
      )}
      {listing.networks.length > 0 && (
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Status</th>
              <th>Network</th>
              <th>Kind</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {listing.networks.map((n) => (
              <tr
                key={n.id}
                className={`cursor-pointer hover:bg-base-300 ${selected === n.id ? 'bg-base-300 outline outline-1 -outline-offset-1 outline-primary' : ''}`}
                onClick={() => props.onSelect(n.id)}
                aria-selected={selected === n.id}
              >
                <td>
                  <StatusBadge row={n} />
                </td>
                <td>
                  <div>{n.entry?.name ?? n.id}</div>
                  {n.entry && n.entry.name !== n.id && (
                    <div className="font-mono text-xs opacity-60">{n.id}</div>
                  )}
                </td>
                <td className="opacity-80">{n.entry?.kind ?? '—'}</td>
                <td className="opacity-80" title={createdTitle(n)}>
                  {n.createdAgo ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
