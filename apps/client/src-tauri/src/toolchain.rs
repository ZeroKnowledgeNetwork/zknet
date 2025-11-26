//! Tauri command handlers for toolchain operations.

use anyhow::Result;
use zknet_core::paths::AppPaths;

/// Download and verify nargo toolchain availability.
#[tauri::command]
pub async fn download_nargo_toolchain(
    noir_version: String,
    platform_arch: String,
    url_toolchains: String,
) -> Result<String, String> {
    try_download_nargo(&noir_version, &platform_arch, &url_toolchains)
        .await
        .map_err(|e| e.to_string())
}

async fn try_download_nargo(
    noir_version: &str,
    platform_arch: &str,
    url_toolchains: &str,
) -> Result<String> {
    let app_paths = AppPaths::new("zknet-client");
    let cache_dir = app_paths.dir_noir_cache(noir_version);

    // Check if already cached
    if cache_dir.exists() {
        return Ok(format!(
            "Nargo v{} cached at: {}",
            noir_version,
            cache_dir.display()
        ));
    }

    // Build HTTP client
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;

    // Download and extract toolchain
    zknet_core::toolchain::verify_or_download(
        &client,
        noir_version,
        platform_arch,
        url_toolchains,
        cache_dir.clone(),
    )
    .await?;

    Ok(format!("Nargo v{} installed at: {}", noir_version, cache_dir.display()))
}

/// Get the path to the cached nargo toolchain.
#[tauri::command]
pub fn get_nargo_path(noir_version: String) -> Result<String, String> {
    let app_paths = AppPaths::new("zknet-client");
    let cache_dir = app_paths.dir_noir_cache(&noir_version);

    if cache_dir.exists() {
        Ok(cache_dir.display().to_string())
    } else {
        Err(format!("Nargo v{} not found", noir_version))
    }
}

/// Execute nargo command with arguments.
#[tauri::command]
pub async fn run_nargo_command(
    noir_version: String,
    args: Vec<String>,
) -> Result<String, String> {
    let app_paths = AppPaths::new("zknet-client");
    let cache_dir = app_paths.dir_noir_cache(&noir_version);
    let nargo_path = cache_dir.join("nargo");

    let mut cmd = tokio::process::Command::new(&nargo_path);
    cmd.args(&args);

    let output = cmd.output().await.map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(stdout)
    } else {
        Err(format!("nargo failed: {}", stderr))
    }
}
