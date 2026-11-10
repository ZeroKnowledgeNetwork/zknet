//! WalletShield, spawned from a network's directory with the CLI's stdio.

use anyhow::Result;
use zknet_client_core::{
    config::AppConfig,
    network::{Asset, Layout, NetworkId},
    walletshield,
};

/// Run the network's WalletShield until it exits.
pub async fn run(config: &AppConfig, layout: &Layout, network_id: &NetworkId) -> Result<()> {
    let dir_network = layout.network_dir(network_id);
    let path_walletshield = layout.asset_path(network_id, Asset::Walletshield);

    // spawn the walletshield process
    let mut command = tokio::process::Command::new(path_walletshield);
    command.current_dir(&dir_network);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    command.args(walletshield::args(
        &config.walletshield_listen_address,
        &config.walletshield_log_level,
    ));

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
