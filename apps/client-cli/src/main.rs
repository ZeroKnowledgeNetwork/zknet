use std::{process::ExitCode, sync::Arc};

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
use zknet_core::{
    context::AppContext,
    network::{
        http_client, list, prepare, FetchEvent, FetchOptions, Layout, NetworkId, OnFetchEvent,
        Platform,
    },
};

mod list;
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
    /// List the mix networks: live ones first, then those on this device
    List(ListArgs),
    /// Download a network's assets if needed and run its client
    Connect(ConnectArgs),
}

#[derive(Args, Debug)]
struct ListArgs {
    /// Only print network ids
    #[arg(short, long)]
    quiet: bool,
    /// Output format
    #[arg(long, value_enum, default_value_t)]
    format: list::Format,
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
    let prepared = prepare(&http_client()?, &layout, &id, options, Some(on_event)).await?;
    if prepared.other_source {
        let from = prepared
            .origin_label
            .map_or_else(|| "the default source".into(), |host| host.to_string());
        println!("{id} isn't listed here; running the copy downloaded from {from}");
    }

    walletshield::run(&ctx.config, &layout, &id).await
}

#[tokio::main]
async fn main() -> Result<ExitCode> {
    let cli = Cli::parse();

    let app_name = APP_NAME.replace('_', "-");
    let platform = Platform::current()?;
    let mut ctx = AppContext::new(&app_name, CONFIG_JSON, platform);
    if let Some(url) = cli.network_url {
        ctx.config.url_network = url;
    }

    let args = match cli.command {
        Some(Command::List(a)) => {
            let listing = list(&http_client()?, &layout(&ctx)).await;
            let (mut out, mut err) = (std::io::stdout(), std::io::stderr());
            let read = list::print(&listing, a.format, a.quiet, &mut out, &mut err)?;
            return Ok(if read {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            });
        }
        Some(Command::Connect(args)) => args,
        None => cli.connect,
    };
    println!("Starting {app_name} v{VERSION} on {}", ctx.platform);
    ctx.config.walletshield_thin |= args.thin;
    println!("App data directory: {}", ctx.paths.dir_data().display());
    // the built-in network source is never shown; an overridden one is
    if let Some(host) = layout(&ctx).source_label() {
        println!("Network source: {host}");
    }
    let c = &ctx.config;
    println!(
        "WalletShield: listen {} · log {}{}",
        c.walletshield_listen_address,
        c.walletshield_log_level,
        if c.walletshield_thin { " · thin" } else { "" }
    );
    connect(ctx, args).await?;
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
        Cli::try_parse_from([&["zknet-client-cli"], args].concat())
    }

    fn connect_id(cli: Cli) -> String {
        match cli.command {
            Some(Command::Connect(a)) => a.network_id.unwrap().to_string(),
            None => cli.connect.network_id.unwrap().to_string(),
            Some(Command::List(_)) => panic!("parsed as list"),
        }
    }

    #[test]
    fn list_is_a_subcommand() {
        let cli = parse(&["list", "--network-url", "http://127.0.0.1:1"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::List(ListArgs {
                quiet: false,
                format: list::Format::Table
            }))
        ));
        assert_eq!(cli.network_url.as_deref(), Some("http://127.0.0.1:1"));
        let cli = parse(&["list", "-q", "--format", "json"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::List(ListArgs {
                quiet: true,
                format: list::Format::Json
            }))
        ));
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

    /// "Is this the built-in source?" is answered by zknet_core alone.
    #[test]
    fn the_configured_source_is_the_built_in_one() {
        let config: serde_json::Value = serde_json::from_str(CONFIG_JSON).unwrap();
        assert_eq!(config["urlNetwork"], zknet_core::network::DEFAULT_SOURCE);
    }
}
