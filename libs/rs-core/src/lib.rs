use std::sync::Arc;

use anyhow::Result;

use crate::network::{
    fetch, http_client, FetchEvent, FetchOptions, Layout, NetworkId, OnFetchEvent,
};

pub mod config;
pub mod context;
pub mod net;
pub mod network;
pub mod paths;

/// WalletShield's arguments, run from the network directory holding `client.toml`.
fn walletshield_args(config: &crate::config::AppConfig) -> Vec<String> {
    let mut args = vec![
        "-listen".into(),
        config.walletshield_listen_address.clone(),
        "-config".into(),
        "client.toml".into(),
        "-log_level".into(),
        config.walletshield_log_level.clone(),
    ];
    if config.walletshield_thin {
        args.push("-thin".into());
    }
    args
}

/// Start the client for the specified network from the downloaded assets.
async fn start_network_client(
    ctx: crate::context::AppContext,
    network_id: &NetworkId,
) -> Result<()> {
    let layout = layout(&ctx);
    let dir_network = layout.network_dir(network_id);
    let path_walletshield = layout.asset_path(network_id, crate::network::Asset::Walletshield);

    // spawn the walletshield process
    let mut command = tokio::process::Command::new(path_walletshield);
    command.current_dir(&dir_network);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    command.args(walletshield_args(&ctx.config));

    println!("Starting network client...");
    let mut child = command.spawn()?;

    // Handle stdout
    if let Some(stdout) = child.stdout.take() {
        let mut reader = tokio::io::BufReader::new(stdout);
        tokio::spawn(async move {
            let mut line = String::new();
            loop {
                line.clear();
                match tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut line).await {
                    Ok(0) => break, // EOF
                    Ok(_) => print!("{line}"),
                    Err(e) => {
                        eprintln!("Error reading stdout: {e}");
                        break;
                    }
                }
            }
        });
    }

    // Handle stderr
    if let Some(stderr) = child.stderr.take() {
        let mut reader = tokio::io::BufReader::new(stderr);
        tokio::spawn(async move {
            let mut line = String::new();
            loop {
                line.clear();
                match tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut line).await {
                    Ok(0) => break, // EOF
                    Ok(_) => eprint!("{line}"),
                    Err(e) => {
                        eprintln!("Error reading stderr: {e}");
                        break;
                    }
                }
            }
        });
    }

    // Wait for the process to finish (will run until killed)
    let status = child.wait().await?;
    println!("Client for network {network_id} exited with status: {status}");

    Ok(())
}

fn layout(ctx: &crate::context::AppContext) -> Layout {
    Layout::new(
        &ctx.config.url_network,
        ctx.paths.dir_data().join("networks"),
        ctx.platform.clone(),
    )
}

/// Connect to a network by downloading its assets and starting the client.
pub async fn network_connect(ctx: crate::context::AppContext, network_id: &str) -> Result<()> {
    println!("Connecting to network with ID={network_id}...");
    let id = NetworkId::parse(network_id)?;
    let layout = layout(&ctx);

    println!("Downloading network assets...");
    let on_event: OnFetchEvent = Arc::new(|event| match event {
        FetchEvent::Cached { asset } => println!("  {asset:?}: cached"),
        FetchEvent::Finished { asset } => println!("  {asset:?}: downloaded"),
        _ => {}
    });
    let options = FetchOptions {
        refresh: ctx.config.walletshield_thin,
    };
    fetch(&http_client()?, &layout, &id, options, Some(on_event)).await?;

    start_network_client(ctx, &id).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::walletshield_args;
    use crate::config::AppConfig;

    fn config(walletshield_thin: bool) -> AppConfig {
        AppConfig {
            api_listen_address: "127.0.0.1:7000".into(),
            url_network: "http://127.0.0.1:8765".into(),
            walletshield_listen_address: ":7070".into(),
            walletshield_log_level: "INFO".into(),
            walletshield_thin,
        }
    }

    #[test]
    fn walletshield_args_select_thin_mode() {
        assert_eq!(
            walletshield_args(&config(false)),
            [
                "-listen",
                ":7070",
                "-config",
                "client.toml",
                "-log_level",
                "INFO"
            ]
        );
        assert_eq!(
            walletshield_args(&config(true)),
            [
                "-listen",
                ":7070",
                "-config",
                "client.toml",
                "-log_level",
                "INFO",
                "-thin"
            ]
        );
    }
}
