use anyhow::Result;
use clap::Parser;
use zknet_core::network_connect;

#[derive(Parser, Debug)]
#[command(author, version, about = "ZKNetwork Client")]
struct Cli {
    /// The ID of the network to connect to
    network_id: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    network_connect(&cli.network_id).await?;
    Ok(())
}
