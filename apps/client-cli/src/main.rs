use anyhow::Result;
use clap::Parser;
use zknet_core::{context::AppContext, network_connect, utils::get_platform_arch};

const APP_NAME: &str = env!("CARGO_PKG_NAME");
const VERSION: &str = env!("CARGO_PKG_VERSION");

const CONFIG_JSON: &str = include_str!("../assets/config.json");

#[derive(Parser, Debug)]
#[command(author, version, about = "ZKNetwork Client CLI")]
struct Cli {
    /// The ID of the network to connect to
    network_id: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    let app_name = APP_NAME.replace('_', "-");
    let platform_arch = get_platform_arch().expect("Unsupported platform or architecture");
    println!("Starting {app_name} v{VERSION} on {platform_arch}");

    let ctx = AppContext::new(&app_name, CONFIG_JSON, platform_arch);
    println!("App data directory: {}", ctx.paths.dir_data().display());
    println!("Using configuration: {:#?}", ctx.config);

    let toolchain_info = network_connect(ctx, &cli.network_id).await?;
    println!("✓ Nargo v{} available at: {}", toolchain_info.noir_version, toolchain_info.noir_cache_dir.display());
    Ok(())
}
