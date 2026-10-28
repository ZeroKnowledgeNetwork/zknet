import {
  BADGES,
  NetworkRow,
  Listing,
  anyListed,
  autoFillId,
  caption,
  showsSource,
  createdTitle,
  statusHint,
  unreachableText,
} from "./networks";

const row = (
  id: string,
  status: NetworkRow["status"],
  extra: Partial<NetworkRow> = {},
): NetworkRow => ({
  id,
  status,
  entry: { id, kind: "devnet", name: `Devnet · ${id}`, created: "2026-10-24T07:18:14Z" },
  source: "https://built-in.example",
  sourceLabel: null,
  createdAgo: "11 hours ago",
  ...extra,
});

const listing = (networks: NetworkRow[], launchLabel: string | null = null): Listing => ({
  launchSource: launchLabel ? `http://${launchLabel}` : "https://built-in.example",
  launchLabel,
  networks,
  unreachable: [],
});

describe("network list presentation", () => {
  it("captions the built-in source without naming it", () => {
    expect(caption(listing([]))).toBe("Mix Networks");
    expect(caption(listing([], "127.0.0.1:8765"))).toBe("Mix Networks at 127.0.0.1:8765");
  });

  it("never names the built-in source when it is unreachable", () => {
    const error = (sourceLabel: string | null) => ({ source: "x", sourceLabel, error: "e" });
    expect(unreachableText(error(null))).toBe(
      "Couldn't reach the network list. Showing networks on this device.",
    );
    expect(unreachableText(error("127.0.0.1:8765"))).toBe(
      "Couldn't reach 127.0.0.1:8765. Its networks are shown from this device.",
    );
  });

  it("has a badge and a hint for every status", () => {
    for (const status of ["ready", "available", "cached", "unpublished"] as const) {
      expect(BADGES[status].label).not.toBe("");
      expect(statusHint(row("x", status))).not.toBe("");
    }
    // live is the theme's green (accent); success is blue in zkn-dark
    expect(BADGES.ready.className).toContain("badge-accent");
    expect(BADGES.available.className).toContain("badge-accent");
  });

  it("fills in the top row only when it is live and nothing is chosen", () => {
    const live = listing([row("devnet-2", "available"), row("devnet-1", "ready")]);
    expect(autoFillId(live, "")).toBe("devnet-2");
    expect(autoFillId(live, "typed")).toBeNull();
    expect(autoFillId(listing([row("old", "unpublished")]), "")).toBeNull();
    expect(autoFillId(listing([]), "")).toBeNull();
  });

  it("knows when nothing is listed, whatever is on this device", () => {
    expect(anyListed(listing([]))).toBe(false);
    expect(anyListed(listing([row("old", "unpublished"), row("x", "cached")]))).toBe(false);
    expect(anyListed(listing([row("old", "unpublished"), row("new", "available")]))).toBe(true);
  });

  it("shows a Source column only once a non-default source is known", () => {
    expect(showsSource(listing([row("devnet-1", "ready")]))).toBe(false);
    const local = row("dev-local", "ready", { sourceLabel: "127.0.0.1:8765" });
    expect(showsSource(listing([row("devnet-1", "ready"), local]))).toBe(true);
  });

  it("titles CREATED with the full time in the given locale", () => {
    const title = createdTitle(row("devnet-1", "ready"), "en-US");
    expect(title).toContain("October");
    expect(title).toContain("2026");
    expect(createdTitle(row("x", "unpublished", { entry: null }))).toBeUndefined();
  });
});
