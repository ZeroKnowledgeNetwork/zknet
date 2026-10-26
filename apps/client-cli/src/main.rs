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
    after_help = "A bare <NETWORK_ID> is shorthand for `connect <NETWORK_ID>`."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
    /// Discover networks at this base URL as well as those already known
    #[arg(long, global = true)]
    network_url: Option<String>,
}

const SUBCOMMANDS: [&str; 3] = ["list", "connect", "help"];

/// Put `connect` before the first argument that isn't the global `--network-url`,
/// unless it is a subcommand or a help/version flag, so `<network_id>` and
/// `--refresh <network_id>` connect. Clap's own shorthand
/// (`args_conflicts_with_subcommands`) would refuse a global `--network-url`
/// given before the subcommand, which is how the Nx `dev-local` target forwards
/// its arguments.
fn with_default_subcommand(args: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut args: Vec<String> = args.into_iter().collect();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--network-url" => i += 2,
            a if a.starts_with("--network-url=") => i += 1,
            a if SUBCOMMANDS.contains(&a) || ["-h", "--help", "-V", "--version"].contains(&a) => {
                break
            }
            _ => {
                args.insert(i, "connect".into());
                break;
            }
        }
    }
    args
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
    #[arg(value_parser = parse_network_id)]
    network_id: NetworkId,
    /// Download the network's assets even if a current copy is on this device
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
    let id = args.network_id;
    let layout = layout(&ctx);
    println!("Connecting to network {id}...");

    let on_event: OnFetchEvent = Arc::new(|event| match event {
        FetchEvent::Started { asset, total } => println!("  {asset:?}: downloading {total} bytes"),
        FetchEvent::Cached { asset } => println!("  {asset:?}: cached"),
        FetchEvent::Finished { asset } => println!("  {asset:?}: downloaded"),
        FetchEvent::Progress { .. } => {}
    });
    let options = FetchOptions {
        refresh: args.refresh,
        ..Default::default()
    };
    let prepared = prepare(&http_client()?, &layout, &id, options, Some(on_event)).await?;
    if let Some(host) = &prepared.source_label {
        if prepared.source != layout.base_url {
            println!("{id} is published at {host}");
        }
    }

    walletshield::run(&ctx.config, &layout, &id).await
}

#[tokio::main]
async fn main() -> Result<ExitCode> {
    let cli = Cli::parse_from(with_default_subcommand(std::env::args()));

    let app_name = APP_NAME.replace('_', "-");
    let platform = Platform::current()?;
    let mut ctx = AppContext::new(&app_name, CONFIG_JSON, platform);
    if let Some(url) = cli.network_url {
        ctx.config.url_network = url;
    }

    let args = match cli.command {
        Command::List(a) => {
            let listing = list(&http_client()?, &layout(&ctx)).await;
            let (mut out, mut err) = (std::io::stdout(), std::io::stderr());
            let read = list::print(&listing, a.format, a.quiet, &mut out, &mut err)?;
            return Ok(if read {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            });
        }
        Command::Connect(args) => args,
    };
    println!("Starting {app_name} v{VERSION} on {}", ctx.platform);
    println!("App data directory: {}", ctx.paths.dir_data().display());
    // the built-in network source is never shown; an overridden one is
    if let Some(host) = layout(&ctx).source_label() {
        println!("Network source: {host}");
    }
    let c = &ctx.config;
    println!(
        "WalletShield: listen {} · log {}",
        c.walletshield_listen_address, c.walletshield_log_level
    );
    connect(ctx, args).await?;
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
        let argv = [&["zknet-client-cli"], args].concat();
        Cli::try_parse_from(with_default_subcommand(argv.iter().map(|a| a.to_string())))
    }

    fn connect_id(cli: Cli) -> String {
        match cli.command {
            Command::Connect(a) => a.network_id.to_string(),
            Command::List(_) => panic!("parsed as list"),
        }
    }

    #[test]
    fn list_is_a_subcommand() {
        let cli = parse(&["list", "--network-url", "http://127.0.0.1:1"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::List(ListArgs {
                quiet: false,
                format: list::Format::Table
            })
        ));
        assert_eq!(cli.network_url.as_deref(), Some("http://127.0.0.1:1"));
        let cli = parse(&["list", "-q", "--format", "json"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::List(ListArgs {
                quiet: true,
                format: list::Format::Json
            })
        ));
    }

    #[test]
    fn a_bare_id_and_connect_are_the_same() {
        assert_eq!(connect_id(parse(&["devnet-1"]).unwrap()), "devnet-1");
        assert_eq!(
            connect_id(parse(&["connect", "devnet-1"]).unwrap()),
            "devnet-1"
        );
        // the dev-local target forwards any command after its --network-url
        for argv in [
            &["--network-url", "http://x", "connect", "dev-local"][..],
            &["--network-url=http://x", "dev-local"],
        ] {
            let cli = parse(argv).unwrap();
            assert_eq!(cli.network_url.as_deref(), Some("http://x"));
            assert_eq!(connect_id(cli), "dev-local");
        }
        assert!(matches!(
            parse(&["--network-url", "http://x", "list", "-q"])
                .unwrap()
                .command,
            Command::List(ListArgs { quiet: true, .. })
        ));
        assert!(matches!(
            parse(&["--refresh", "devnet-1"]).unwrap().command,
            Command::Connect(ConnectArgs { refresh: true, .. })
        ));
        assert!(matches!(
            parse(&["connect", "devnet-1", "--refresh"])
                .unwrap()
                .command,
            Command::Connect(ConnectArgs { refresh: true, .. })
        ));
        // thin mode is the network's, not the launch's
        assert!(parse(&["dev-local", "--thin"]).is_err());
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
