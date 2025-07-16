use anyhow::{ensure, Context, Result};
use net::download;
use tokio::fs::File;

pub mod net;
pub mod utils;

// TODO: extract to config
const URL_NETWORK: &str = "https://test.net.zknet.io";
const DIR_APP_LOCAL_DATA: &str = "/tmp/zknet";

pub async fn network_connect(network_id: &str) -> Result<()> {
    println!("Connecting to network with ID={network_id}...");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    let url_client_cfg = format!("{URL_NETWORK}/{network_id}/client.toml");
    let file_client_cfg = format!("{DIR_APP_LOCAL_DATA}/{network_id}/client.toml");
    println!("Downloading...\n  << {url_client_cfg}\n  >> {file_client_cfg}");

    // ensure network_id is safe
    let path = std::path::Path::new(&network_id);
    ensure!(
        !path
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_))),
        "invalid network id: {path:?}"
    );

    // create the directory, ensuring it exists
    tokio::fs::create_dir_all(
        std::path::Path::new(&file_client_cfg)
            .parent()
            .context("Invalid file path")?,
    )
    .await
    .with_context(|| format!("creating directory for {file_client_cfg}"))?;

    let mut file = File::create(&file_client_cfg).await?;

    download(
        &client,
        &url_client_cfg,
        &mut file,
        Some(Box::new(|p| {
            println!("Download progress: {}/{}", p.progress_total, p.total);
        })),
        None,
        None,
    )
    .await?;

    println!("Client configuration downloaded to: {file_client_cfg}");

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
