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

    let platform_arch = utils::get_platform_arch().expect("unsupported platform or architecture");

    // create the directory for network assets, ensuring it exists
    let dir_network = ctx.paths.dir_data().join("networks").join(network_id);
    tokio::fs::create_dir_all(&dir_network).await?;

    let url_base = format!("{}/{}", ctx.config.url_network, network_id);

    let ctx_dl = DlCtx {
        client: Arc::new(client),
        dir: Arc::new(dir_network),
        url_base: Arc::from(url_base),
        platform_arch: Arc::from(platform_arch),
    };

    println!("Downloading network assets...");
    tokio::try_join!(
        ctx_dl.asset("client.toml", false, false),
        ctx_dl.asset("services.json", false, false),
        ctx_dl.asset("walletshield", true, false),
    )?;

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
