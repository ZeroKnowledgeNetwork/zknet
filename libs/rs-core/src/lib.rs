use crate::context::AppContext;
use anyhow::{ensure, Result};
use net::download;
use tokio::fs::File;

pub mod config;
pub mod context;
pub mod net;
pub mod paths;
pub mod utils;

pub async fn network_connect(ctx: AppContext, network_id: &str) -> Result<()> {
    println!("Connecting to network with ID={network_id}...");

    // ensure network_id is safe
    let path = std::path::Path::new(&network_id);
    ensure!(
        !path
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_))),
        "invalid network id: {path:?}"
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    let url_client_cfg = format!("{}/{network_id}/client.toml", ctx.config.url_network);
    let dir_network = ctx.paths.dir_data().join("networks").join(network_id);
    let path_client_cfg = dir_network.join("client.toml");

    println!("Downloading...");
    println!("  << {url_client_cfg}");
    println!("  >> {}", path_client_cfg.display());

    // create the directory, ensuring it exists
    tokio::fs::create_dir_all(&dir_network).await?;

    let mut file_client_cfg = File::create(&path_client_cfg).await?;

    download(
        &client,
        &url_client_cfg,
        &mut file_client_cfg,
        Some(Box::new(|p| {
            println!("Download progress: {}/{}", p.progress_total, p.total);
        })),
        None,
        None,
    )
    .await?;

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
