use anyhow::Result;
use clap::Parser;
use zknet_core::{network_connect, utils::get_platform_arch};

const APP_NAME: &str = "ZKNetwork Client CLI";
const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser, Debug)]
#[command(author, version, about = APP_NAME)]
struct Cli {
    /// The ID of the network to connect to
    network_id: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    let platform_arch = get_platform_arch().expect("Unsupported platform or architecture");
    println!("Starting {APP_NAME} v{VERSION} on {platform_arch}");

    network_connect(&cli.network_id).await?;
    Ok(())
}
