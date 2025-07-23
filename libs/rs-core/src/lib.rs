use std::{path::PathBuf, sync::Arc};

use crate::net::{download, ProgressCallback, ProgressPayload};
use anyhow::{ensure, Result};
use reqwest::Client;
use tokio::fs::File;

pub mod config;
pub mod context;
pub mod net;
pub mod paths;
pub mod utils;

#[derive(Clone)]
struct DlCtx {
    client: Arc<Client>,
    dir: Arc<PathBuf>,
    url_base: Arc<str>,
    platform_arch: Arc<String>,
}

impl DlCtx {
    async fn asset(&self, name: &str, is_binary: bool, show_progress: bool) -> Result<()> {
        let mut url = format!("{}/{name}", self.url_base);
        if is_binary {
            url.push_str(&format!("-{}", self.platform_arch));
        }
        let path = self.dir.join(name);
        println!("  << {url}\n  >> {}", path.display());

        let mut file = File::create(&path).await?;

        let progress = show_progress.then(|| {
            Box::new(move |p: ProgressPayload| {
                println!("Download progress: {}/{}", p.progress_total, p.total);
            }) as ProgressCallback
        });

        download(&self.client, &url, &mut file, progress, None, None).await?;

        if is_binary {
            let platform = self.platform_arch.split('-').next().unwrap_or("");

            // if platform is unix, set the file permissions to 755
            if platform == "linux" || platform == "macos" {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mut perms = file.metadata().await?.permissions();
                    perms.set_mode(0o755); // rwxr-xr-x
                    tokio::fs::set_permissions(&path, perms).await?;
                }
            }

            // if platform is windows, rename the file to .exe
            if platform == "windows" {
                let new_path = path.with_extension("exe");
                tokio::fs::rename(&path, &new_path).await?;
                println!("Renamed {} to {}", path.display(), new_path.display());
            }
        }

        Ok::<(), anyhow::Error>(())
    }
}

/// Start the client for the specified network from the downloaded assets.
async fn start_network_client(ctx: crate::context::AppContext, network_id: &str) -> Result<()> {
    let dir_network = ctx.paths.dir_data().join("networks").join(network_id);

    let platform = ctx.platform_arch.split('-').next().unwrap_or("");
    let mut path_walletshield = dir_network.join("walletshield");
    if platform == "windows" {
        path_walletshield.set_extension("exe");
    }

    // ensure the walletshield binary exists
    if !path_walletshield.exists() {
        return Err(anyhow::anyhow!(
            "Walletshield binary not found at {}",
            path_walletshield.display()
        ));
    }

    // spawn the walletshield process
    let mut command = tokio::process::Command::new(path_walletshield);
    command.current_dir(&dir_network);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    command.arg("-listen");
    command.arg(ctx.config.walletshield_listen_address);
    command.arg("-config").arg("client.toml");

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

/// Connect to a network by downloading its assets and starting the client.
pub async fn network_connect(ctx: crate::context::AppContext, network_id: &str) -> Result<()> {
    println!("Connecting to network with ID={network_id}...");

    // ensure network_id is safe
    let path = std::path::Path::new(&network_id);
    ensure!(
        !path
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_))),
        "invalid network id: {path:?}"
    );

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    // create the directory for network assets, ensuring it exists
    let dir_network = ctx.paths.dir_data().join("networks").join(network_id);
    tokio::fs::create_dir_all(&dir_network).await?;

    let url_base = format!("{}/{}", ctx.config.url_network, network_id);

    let ctx_dl = DlCtx {
        client: Arc::new(client),
        dir: Arc::new(dir_network),
        url_base: Arc::from(url_base),
        platform_arch: Arc::from(ctx.platform_arch.clone()),
    };

    println!("Downloading network assets...");
    tokio::try_join!(
        ctx_dl.asset("client.toml", false, false),
        ctx_dl.asset("services.json", false, false),
        ctx_dl.asset("walletshield", true, false),
    )?;

    start_network_client(ctx, network_id).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn it_works() {
        let result = 2 + 2;
        assert_eq!(result, 4);
    }
}
