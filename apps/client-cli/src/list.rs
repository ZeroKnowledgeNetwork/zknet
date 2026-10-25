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

/// A row's STATUS: the words of the shared status, and where an other-source
/// copy came from. The built-in source is never named.
fn status(n: &NetworkEntry) -> String {
    match n.status {
        Status::Ready => "ready".into(),
        Status::Available => "available".into(),
        Status::Cached => "cached".into(),
        Status::Unlisted => "unlisted".into(),
        Status::OtherSource => match &n.origin_label {
            Some(host) => format!("from {host}"),
            None => "from default source".into(),
        },
    }
}

fn row(n: &NetworkEntry) -> [String; 5] {
    let entry = n.entry.as_ref();
    [
        n.id.to_string(),
        entry.map_or("-".into(), |e| format!("{:?}", e.kind).to_lowercase()),
        n.created_ago.clone().unwrap_or_else(|| "-".into()),
        status(n),
        // a name that only repeats the id is noise
        entry
            .filter(|e| e.name != n.id.as_str())
            .map_or(String::new(), |e| e.name.clone()),
    ]
}

/// One network for `--format json`: data, so the origin is the full URL.
#[derive(Serialize)]
struct JsonRow<'a> {
    id: &'a str,
    status: Status,
    kind: Option<String>,
    name: Option<&'a str>,
    created: Option<&'a str>,
    origin: Option<&'a str>,
}

fn json_row(n: &NetworkEntry) -> String {
    let entry = n.entry.as_ref();
    serde_json::to_string(&JsonRow {
        id: n.id.as_str(),
        status: n.status,
        kind: entry.map(|e| format!("{:?}", e.kind).to_lowercase()),
        name: entry.map(|e| e.name.as_str()),
        created: entry.map(|e| e.created.as_str()),
        origin: n.origin.as_deref(),
    })
    .expect("a row serializes")
}

/// Print a listing; returns whether the index was read. Rows go to `out`,
/// warnings and the empty notice to `err`, as docker and kubectl do.
pub fn print(
    listing: &Listing,
    format: Format,
    quiet: bool,
    out: &mut impl Write,
    err: &mut impl Write,
) -> std::io::Result<bool> {
    let at = listing
        .source_label
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
    match &listing.index_error {
        Some(e) => {
            // the error names an overridden source itself, and never the built-in one
            writeln!(err, "warning: couldn't read the network list: {e}")?;
            Ok(false)
        }
        None => {
            if rows.is_empty() && !quiet && format == Format::Table {
                writeln!(err, "No listed networks{at}.")?;
            }
            Ok(true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zknet_core::network::{IndexEntry, NetworkId, NetworkKind};

    const DIST: &str = "https://dist.zknet.io";
    const LOCAL: &str = "http://127.0.0.1:8765";

    fn entry(id: &str, kind: NetworkKind, name: &str, ago: &str) -> (IndexEntry, String) {
        let e = IndexEntry {
            id: id.into(),
            kind,
            name: name.into(),
            created: "2026-10-24T00:00:00Z".into(),
        };
        (e, ago.into())
    }

    fn net(
        id: &str,
        status: Status,
        e: Option<(IndexEntry, String)>,
        origin: Option<&str>,
        label: Option<&str>,
    ) -> NetworkEntry {
        let (entry, created_ago) = e.map_or((None, None), |(e, a)| (Some(e), Some(a)));
        NetworkEntry {
            id: NetworkId::parse(id).unwrap(),
            status,
            entry,
            origin: origin.map(Into::into),
            origin_label: label.map(Into::into),
            created_ago,
        }
    }

    fn listing(
        source: &str,
        label: Option<&str>,
        networks: Vec<NetworkEntry>,
        error: Option<&str>,
    ) -> Listing {
        Listing {
            source: source.into(),
            source_label: label.map(Into::into),
            networks,
            index_error: error.map(Into::into),
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

    fn default_source() -> Listing {
        let devnet = |id: &str, day: &str, ago: &str| {
            entry(id, NetworkKind::Devnet, &format!("Devnet · {day}"), ago)
        };
        listing(
            DIST,
            None,
            vec![
                net(
                    "devnet-78c3de87",
                    Status::Ready,
                    Some(devnet("devnet-78c3de87", "2026-10-24", "11 hours ago")),
                    Some(DIST),
                    None,
                ),
                net(
                    "devnet-78c3de86",
                    Status::Available,
                    Some(devnet("devnet-78c3de86", "2026-10-23", "12 hours ago")),
                    None,
                    None,
                ),
                net(
                    "devnet-78c3de28",
                    Status::Unlisted,
                    Some(devnet("devnet-78c3de28", "2026-10-23", "23 hours ago")),
                    Some(DIST),
                    None,
                ),
            ],
            None,
        )
    }

    #[test]
    fn the_default_table() {
        let (out, err, ok) = run(&default_source(), Format::Table, false);
        assert_eq!(
            out,
            "\
NETWORK ID        KIND      CREATED        STATUS      NAME
devnet-78c3de87   devnet    11 hours ago   ready       Devnet · 2026-10-24
devnet-78c3de86   devnet    12 hours ago   available   Devnet · 2026-10-23
devnet-78c3de28   devnet    23 hours ago   unlisted    Devnet · 2026-10-23
"
        );
        assert_eq!((err.as_str(), ok), ("", true));
    }

    #[test]
    fn an_overridden_source_names_hosts_but_never_the_default() {
        let l = listing(
            LOCAL,
            Some("127.0.0.1:8765"),
            vec![
                net(
                    "dev-local",
                    Status::Ready,
                    Some(entry(
                        "dev-local",
                        NetworkKind::Local,
                        "dev-local",
                        "2 hours ago",
                    )),
                    Some(LOCAL),
                    Some("127.0.0.1:8765"),
                ),
                net(
                    "devnet-78c3de87",
                    Status::OtherSource,
                    Some(entry(
                        "devnet-78c3de87",
                        NetworkKind::Devnet,
                        "Devnet · 2026-10-24",
                        "11 hours ago",
                    )),
                    Some(DIST),
                    None,
                ),
                net(
                    "lab-1",
                    Status::OtherSource,
                    None,
                    Some("http://10.0.0.2:8765"),
                    Some("10.0.0.2:8765"),
                ),
                net("meep", Status::Unlisted, None, None, None),
            ],
            None,
        );
        let (out, _, _) = run(&l, Format::Table, false);
        assert_eq!(
            out,
            "\
NETWORK ID        KIND      CREATED        STATUS                NAME
dev-local         local     2 hours ago    ready
devnet-78c3de87   devnet    11 hours ago   from default source   Devnet · 2026-10-24
lab-1             -         -              from 10.0.0.2:8765
meep              -         -              unlisted
"
        );
        assert!(!out.contains("dist.zknet.io"));
    }

    #[test]
    fn quiet_prints_ids_in_table_order() {
        let (out, err, _) = run(&default_source(), Format::Table, true);
        assert_eq!(out, "devnet-78c3de87\ndevnet-78c3de86\ndevnet-78c3de28\n");
        assert_eq!(err, "");
    }

    #[test]
    fn json_is_one_object_per_line_with_the_full_origin() {
        let (out, _, _) = run(&default_source(), Format::Json, false);
        let rows: Vec<serde_json::Value> = out
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows[0],
            serde_json::json!({"id": "devnet-78c3de87", "status": "ready", "kind": "devnet",
                "name": "Devnet · 2026-10-24", "created": "2026-10-24T00:00:00Z", "origin": DIST})
        );
        assert_eq!(rows[1]["origin"], serde_json::Value::Null);
    }

    #[test]
    fn nothing_listed_says_so_on_stderr_without_a_header() {
        let (out, err, ok) = run(&listing(DIST, None, vec![], None), Format::Table, false);
        assert_eq!(
            (out.as_str(), err.as_str(), ok),
            ("", "No listed networks.\n", true)
        );
        let (_, err, _) = run(
            &listing(LOCAL, Some("127.0.0.1:8765"), vec![], None),
            Format::Table,
            false,
        );
        assert_eq!(err, "No listed networks at 127.0.0.1:8765.\n");
        let (out, err, _) = run(&listing(DIST, None, vec![], None), Format::Table, true);
        assert_eq!((out.as_str(), err.as_str()), ("", ""));
    }

    #[test]
    fn an_unreachable_index_prints_what_is_on_disk_and_fails() {
        let mut l = default_source();
        l.networks.truncate(1);
        l.networks[0].status = Status::Cached;
        l.index_error = Some("request failed: error sending request".into());
        let (out, err, ok) = run(&l, Format::Table, false);
        assert!(
            out.contains("devnet-78c3de87   devnet    11 hours ago   cached"),
            "{out}"
        );
        assert_eq!(
            err,
            "warning: couldn't read the network list: request failed: error sending request\n"
        );
        assert!(!ok);
    }
}
