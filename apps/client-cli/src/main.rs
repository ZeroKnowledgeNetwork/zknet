use std::{io::Write, sync::Arc};

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
use zknet_core::{
    context::AppContext,
    network::{
        fetch, http_client, list, FetchEvent, FetchOptions, Layout, Listing, NetworkId,
        OnFetchEvent, Platform,
    },
};

mod walletshield;

const APP_NAME: &str = env!("CARGO_PKG_NAME");
const VERSION: &str = env!("CARGO_PKG_VERSION");

const CONFIG_JSON: &str = include_str!("../assets/config.json");

/// `zknet-client-cli <network_id>` is shorthand for `connect <network_id>`.
#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "ZKNetwork Client CLI",
    args_conflicts_with_subcommands = true,
    subcommand_negates_reqs = true
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[command(flatten)]
    connect: ConnectArgs,
    /// Use this base URL for networks and their assets instead of the configured one
    #[arg(long, global = true)]
    network_url: Option<String>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// List live and cached networks: ids on stdout, details on stderr
    List,
    /// Download a network's assets if needed and run its client
    Connect(ConnectArgs),
}

#[derive(Args, Debug)]
struct ConnectArgs {
    /// The ID of the network to connect to
    #[arg(required = true, value_parser = parse_network_id)]
    network_id: Option<NetworkId>,
    /// Run WalletShield as a thin client of an already running local client daemon
    #[arg(long)]
    thin: bool,
    /// Download the network's assets even if they are cached (implied by --thin)
    #[arg(long)]
    refresh: bool,
}

fn parse_network_id(s: &str) -> Result<NetworkId, String> {
    NetworkId::parse(s).map_err(|e| e.to_string())
}

fn layout(ctx: &AppContext) -> Layout {
    Layout::new(
        &ctx.config.url_network,
        ctx.paths.dir_data().join("networks"),
        ctx.platform.clone(),
    )
}

/// Ids on `out`, one per line, so they feed `connect`; a table on `err`.
fn print_listing(listing: &Listing, out: &mut impl Write, err: &mut impl Write) -> Result<()> {
    if let Some(e) = &listing.index_error {
        writeln!(err, "No network index: {e}")?;
    }
    for n in &listing.networks {
        writeln!(out, "{}", n.id)?;
        let (kind, name) = match &n.listed {
            Some(l) => (format!("{:?}", l.kind).to_lowercase(), l.name.as_str()),
            None => ("-".into(), "-"),
        };
        let status = match (n.listed.is_some(), n.cached) {
            (true, true) => "live, cached",
            (true, false) => "live",
            (false, _) => "cached, not listed",
        };
        writeln!(err, "  {:<24} {:<8} {:<36} {status}", n.id, kind, name)?;
    }
    Ok(())
}

async fn connect(ctx: AppContext, args: ConnectArgs) -> Result<()> {
    let id = args.network_id.expect("clap requires a network id");
    let layout = layout(&ctx);
    println!("Connecting to network {id}...");

    let on_event: OnFetchEvent = Arc::new(|event| match event {
        FetchEvent::Started { asset, total } => println!("  {asset:?}: downloading {total} bytes"),
        FetchEvent::Cached { asset } => println!("  {asset:?}: cached"),
        FetchEvent::Finished { asset } => println!("  {asset:?}: downloaded"),
        FetchEvent::Progress { .. } => {}
    });
    let options = FetchOptions {
        refresh: args.refresh || ctx.config.walletshield_thin,
    };
    fetch(&http_client()?, &layout, &id, options, Some(on_event)).await?;

    walletshield::run(&ctx.config, &layout, &id).await
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    let app_name = APP_NAME.replace('_', "-");
    let platform = Platform::current()?;
    let mut ctx = AppContext::new(&app_name, CONFIG_JSON, platform);
    if let Some(url) = cli.network_url {
        ctx.config.url_network = url;
    }

    let args = match cli.command {
        Some(Command::List) => {
            let listing = list(&http_client()?, &layout(&ctx)).await;
            return print_listing(&listing, &mut std::io::stdout(), &mut std::io::stderr());
        }
        Some(Command::Connect(args)) => args,
        None => cli.connect,
    };
    println!("Starting {app_name} v{VERSION} on {}", ctx.platform);
    ctx.config.walletshield_thin |= args.thin;
    println!("App data directory: {}", ctx.paths.dir_data().display());
    println!("Using configuration: {:#?}", ctx.config);
    connect(ctx, args).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use zknet_core::network::{IndexEntry, NetworkEntry, NetworkKind};

    fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
        Cli::try_parse_from([&["zknet-client-cli"], args].concat())
    }

    fn connect_id(cli: Cli) -> String {
        match cli.command {
            Some(Command::Connect(a)) => a.network_id.unwrap().to_string(),
            None => cli.connect.network_id.unwrap().to_string(),
            Some(Command::List) => panic!("parsed as list"),
        }
    }

    #[test]
    fn list_is_a_subcommand() {
        let cli = parse(&["list", "--network-url", "http://127.0.0.1:1"]).unwrap();
        assert!(matches!(cli.command, Some(Command::List)));
        assert_eq!(cli.network_url.as_deref(), Some("http://127.0.0.1:1"));
    }

    #[test]
    fn a_bare_id_and_connect_are_the_same() {
        assert_eq!(connect_id(parse(&["devnet-1"]).unwrap()), "devnet-1");
        assert_eq!(
            connect_id(parse(&["connect", "devnet-1"]).unwrap()),
            "devnet-1"
        );
        let cli = parse(&["dev-local", "--network-url", "http://x", "--thin"]).unwrap();
        assert!(cli.connect.thin);
        let cli = parse(&["connect", "devnet-1", "--refresh"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Connect(ConnectArgs { refresh: true, .. }))
        ));
    }

    #[test]
    fn reserved_and_invalid_ids_are_refused() {
        for args in [
            &["connect", "list"][..],
            &["connect", "help"],
            &["../x"],
            &["Dev"],
        ] {
            let err = parse(args).unwrap_err();
            assert_eq!(
                err.kind(),
                clap::error::ErrorKind::ValueValidation,
                "{args:?}"
            );
        }
        assert!(parse(&[]).is_err());
    }

    #[test]
    fn listing_prints_ids_alone_on_stdout() {
        let id = |s| NetworkId::parse(s).unwrap();
        let listing = Listing {
            networks: vec![
                NetworkEntry {
                    id: id("devnet-2"),
                    listed: Some(IndexEntry {
                        id: "devnet-2".into(),
                        kind: NetworkKind::Devnet,
                        name: "Devnet two".into(),
                        created: "2026-10-23T12:00:00Z".into(),
                    }),
                    cached: true,
                },
                NetworkEntry {
                    id: id("dev-old"),
                    listed: None,
                    cached: true,
                },
            ],
            index_error: None,
        };
        let (mut out, mut err) = (Vec::new(), Vec::new());
        print_listing(&listing, &mut out, &mut err).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "devnet-2\ndev-old\n");
        let err = String::from_utf8(err).unwrap();
        assert!(
            err.contains("devnet   Devnet two") && err.contains("live, cached"),
            "{err}"
        );
        assert!(err.contains("cached, not listed"), "{err}");
    }
}
