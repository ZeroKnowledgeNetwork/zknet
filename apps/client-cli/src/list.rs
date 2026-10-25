//! `zknet-client-cli list`: the network list as `docker ps` lays out a table.

use std::io::Write;

use clap::ValueEnum;
use serde::Serialize;
use zknet_core::network::{Listing, NetworkEntry, Status};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum)]
pub enum Format {
    /// A table with column headers
    #[default]
    Table,
    /// One JSON object per network and line
    Json,
}

/// Columns as docker's formatter writes them: tabwriter minwidth 10, padding 3
/// (docker/cli `cli/command/formatter/formatter.go`). The last column is never
/// padded, and no line ends in spaces.
fn table(rows: &[[String; 5]]) -> String {
    const MIN_WIDTH: usize = 10;
    const PADDING: usize = 3;
    let width = |i: usize| {
        let widest = rows.iter().map(|r| r[i].chars().count()).max().unwrap_or(0);
        (widest + PADDING).max(MIN_WIDTH)
    };
    let widths: Vec<usize> = (0..4).map(width).collect();
    let mut out = String::new();
    for row in rows {
        let mut line = String::new();
        for (cell, w) in row.iter().zip(&widths) {
            line.push_str(&format!("{cell:<w$}"));
        }
        line.push_str(&row[4]);
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

/// A row's STATUS: the words of the shared status.
fn status(n: &NetworkEntry) -> &'static str {
    match n.status {
        Status::Ready => "ready",
        Status::Available => "available",
        Status::Cached => "cached",
        Status::Unpublished => "unpublished",
    }
}

fn row(n: &NetworkEntry) -> [String; 5] {
    let entry = n.entry.as_ref();
    [
        n.id.to_string(),
        entry.map_or("-".into(), |e| format!("{:?}", e.kind).to_lowercase()),
        n.created_ago.clone().unwrap_or_else(|| "-".into()),
        status(n).into(),
        // a name that only repeats the id is noise
        entry
            .filter(|e| e.name != n.id.as_str())
            .map_or(String::new(), |e| e.name.clone()),
    ]
}

/// One network for `--format json`: data, so the source is the full URL.
#[derive(Serialize)]
struct JsonRow<'a> {
    id: &'a str,
    status: Status,
    kind: Option<String>,
    name: Option<&'a str>,
    created: Option<&'a str>,
    source: &'a str,
}

fn json_row(n: &NetworkEntry) -> String {
    let entry = n.entry.as_ref();
    serde_json::to_string(&JsonRow {
        id: n.id.as_str(),
        status: n.status,
        kind: entry.map(|e| format!("{:?}", e.kind).to_lowercase()),
        name: entry.map(|e| e.name.as_str()),
        created: entry.map(|e| e.created.as_str()),
        source: &n.source,
    })
    .expect("a row serializes")
}

/// Print a listing; returns whether the launch source was read. Rows go to
/// `out`, warnings and the empty notice to `err`, as docker and kubectl do.
pub fn print(
    listing: &Listing,
    format: Format,
    quiet: bool,
    out: &mut impl Write,
    err: &mut impl Write,
) -> std::io::Result<bool> {
    let at = listing
        .launch_label
        .as_ref()
        .map_or_else(String::new, |host| format!(" at {host}"));
    let rows = &listing.networks;
    if quiet {
        for n in rows {
            writeln!(out, "{}", n.id)?;
        }
    } else if format == Format::Json {
        for n in rows {
            writeln!(out, "{}", json_row(n))?;
        }
    } else if !rows.is_empty() {
        let header = ["NETWORK ID", "KIND", "CREATED", "STATUS", "NAME"].map(String::from);
        let all: Vec<[String; 5]> = std::iter::once(header)
            .chain(rows.iter().map(row))
            .collect();
        write!(out, "{}", table(&all))?;
    }
    // each error names an overridden source itself, and never the built-in one
    for e in &listing.unreachable {
        let whose = e.source_label.as_ref().map_or_else(
            || "the network list".to_string(),
            |host| format!("{host}'s network list"),
        );
        writeln!(err, "warning: couldn't read {whose}: {}", e.error)?;
    }
    // nothing published: say so, above or instead of what is on this device
    if listing.unreachable.is_empty()
        && !rows.iter().any(|n| n.status.is_live())
        && !quiet
        && format == Format::Table
    {
        writeln!(err, "No published networks{at}.")?;
    }
    Ok(!listing.launch_unreachable())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zknet_core::network::{IndexEntry, NetworkId, NetworkKind, SourceError};

    const DIST: &str = "https://dist.zknet.io";
    const LOCAL: &str = "http://127.0.0.1:8765";

    fn net(
        id: &str,
        status: Status,
        kind: Option<(NetworkKind, &str, &str)>,
        source: &str,
    ) -> NetworkEntry {
        let created_ago = kind.as_ref().map(|(_, _, ago)| ago.to_string());
        let entry = kind.map(|(kind, name, _)| IndexEntry {
            id: id.into(),
            kind,
            name: name.into(),
            created: "2026-10-24T00:00:00Z".into(),
        });
        NetworkEntry {
            id: NetworkId::parse(id).unwrap(),
            status,
            created_ago,
            entry,
            source: source.into(),
            source_label: zknet_core::network::source_label(source),
        }
    }

    fn listing(launch: &str, networks: Vec<NetworkEntry>, unreachable: &[&str]) -> Listing {
        Listing {
            launch_source: launch.into(),
            launch_label: zknet_core::network::source_label(launch),
            networks,
            unreachable: unreachable
                .iter()
                .map(|s| SourceError {
                    source: s.to_string(),
                    source_label: zknet_core::network::source_label(s),
                    error: "request failed: error sending request".into(),
                })
                .collect(),
        }
    }

    fn run(l: &Listing, format: Format, quiet: bool) -> (String, String, bool) {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let ok = print(l, format, quiet, &mut out, &mut err).unwrap();
        (
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
            ok,
        )
    }

    fn devnet(
        day: &'static str,
        ago: &'static str,
    ) -> Option<(NetworkKind, &'static str, &'static str)> {
        Some((NetworkKind::Devnet, day, ago))
    }

    fn end_user() -> Listing {
        listing(
            DIST,
            vec![
                net(
                    "devnet-78c3de90",
                    Status::Available,
                    devnet("Devnet · 2026-10-25", "3 hours ago"),
                    DIST,
                ),
                net(
                    "devnet-78c3de87",
                    Status::Ready,
                    devnet("Devnet · 2026-10-24", "22 hours ago"),
                    DIST,
                ),
                net(
                    "devnet-78c3de28",
                    Status::Unpublished,
                    devnet("Devnet · 2026-10-23", "2 days ago"),
                    DIST,
                ),
            ],
            &[],
        )
    }

    #[test]
    fn the_default_table() {
        let (out, err, ok) = run(&end_user(), Format::Table, false);
        assert_eq!(
            out,
            "\
NETWORK ID        KIND      CREATED        STATUS        NAME
devnet-78c3de90   devnet    3 hours ago    available     Devnet · 2026-10-25
devnet-78c3de87   devnet    22 hours ago   ready         Devnet · 2026-10-24
devnet-78c3de28   devnet    2 days ago     unpublished   Devnet · 2026-10-23
"
        );
        assert_eq!((err.as_str(), ok), ("", true));
        assert!(!out.contains("dist.zknet.io"));
    }

    #[test]
    fn quiet_prints_ids_in_table_order() {
        let (out, err, _) = run(&end_user(), Format::Table, true);
        assert_eq!(out, "devnet-78c3de90\ndevnet-78c3de87\ndevnet-78c3de28\n");
        assert_eq!(err, "");
    }

    #[test]
    fn json_is_one_object_per_line_with_the_full_source() {
        let (out, _, _) = run(&end_user(), Format::Json, false);
        let rows: Vec<serde_json::Value> = out
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows[1],
            serde_json::json!({"id": "devnet-78c3de87", "status": "ready", "kind": "devnet",
                "name": "Devnet · 2026-10-24", "created": "2026-10-24T00:00:00Z", "source": DIST})
        );
    }

    #[test]
    fn nothing_published_says_so_on_stderr() {
        let (out, err, ok) = run(&listing(DIST, vec![], &[]), Format::Table, false);
        assert_eq!(
            (out.as_str(), err.as_str(), ok),
            ("", "No published networks.\n", true)
        );
        let (_, err, _) = run(&listing(LOCAL, vec![], &[]), Format::Table, false);
        assert_eq!(err, "No published networks at 127.0.0.1:8765.\n");
        let (out, err, _) = run(&listing(DIST, vec![], &[]), Format::Table, true);
        assert_eq!((out.as_str(), err.as_str()), ("", ""));
        let mut copies = end_user();
        copies.networks.retain(|n| !n.status.is_live());
        let (out, err, _) = run(&copies, Format::Table, false);
        assert!(out.contains("unpublished"));
        assert_eq!(err, "No published networks.\n");
    }

    #[test]
    fn only_an_unreachable_launch_source_fails() {
        let mut l = end_user();
        l.networks.truncate(2);
        l.networks.push(net(
            "dev-local",
            Status::Cached,
            Some((NetworkKind::Local, "Local · 2026-10-25", "2 hours ago")),
            LOCAL,
        ));
        l.unreachable = listing(DIST, vec![], &[LOCAL]).unreachable;
        let (_, err, ok) = run(&l, Format::Table, false);
        assert_eq!(err, "warning: couldn't read 127.0.0.1:8765's network list: request failed: error sending request\n");
        assert!(ok);

        l.unreachable = listing(DIST, vec![], &[DIST]).unreachable;
        let (_, err, ok) = run(&l, Format::Table, false);
        assert_eq!(
            err,
            "warning: couldn't read the network list: request failed: error sending request\n"
        );
        assert!(!ok);
    }
}
