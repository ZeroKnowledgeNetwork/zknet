//! WalletShield, spawned from a network's directory with the CLI's stdio.

use anyhow::Result;
use zknet_client_core::{
    config::AppConfig,
    network::{Asset, Layout, NetworkId},
};

/// WalletShield's arguments, run from the network directory holding `client.toml`.
fn walletshield_args(config: &AppConfig) -> Vec<String> {
    vec![
        "-listen".into(),
        config.walletshield_listen_address.clone(),
        "-config".into(),
        "client.toml".into(),
        "-log_level".into(),
        config.walletshield_log_level.clone(),
    ]
}

/// Run the network's WalletShield until it exits.
pub async fn run(config: &AppConfig, layout: &Layout, network_id: &NetworkId) -> Result<()> {
    let dir_network = layout.network_dir(network_id);
    let path_walletshield = layout.asset_path(network_id, Asset::Walletshield);

    // spawn the walletshield process
    let mut command = tokio::process::Command::new(path_walletshield);
    command.current_dir(&dir_network);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    command.args(walletshield_args(config));

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

#[cfg(test)]
mod tests {
    use super::walletshield_args;
    use zknet_client_core::config::AppConfig;

    /// WalletShield picks its mode from the network's config; the CLI never does.
    #[test]
    fn walletshield_args_leave_the_mode_to_the_config() {
        let config = AppConfig {
            api_listen_address: "127.0.0.1:7000".into(),
            url_network: "http://127.0.0.1:8765".into(),
            walletshield_listen_address: ":7070".into(),
            walletshield_log_level: "INFO".into(),
        };
        assert_eq!(
            walletshield_args(&config),
            [
                "-listen",
                ":7070",
                "-config",
                "client.toml",
                "-log_level",
                "INFO"
            ]
        );
    }
}
