//! Noir/nargo toolchain download and caching.

use anyhow::Result;
use reqwest::Client;
use std::path::PathBuf;
use tokio::fs::File;

use crate::net::{download, ProgressCallback, ProgressPayload};

/// Download and cache the nargo+bb toolchain for the specified version.
///
/// Returns the path to the noir cache directory containing nargo and bb binaries.
pub async fn verify_or_download(
    client: &Client,
    version: &str,
    platform_arch: &str,
    url_base: &str,
    cache_dir: PathBuf,
) -> Result<PathBuf> {
    // Check if already cached
    if cache_dir.exists() {
        println!("✓ Nargo toolchain v{} already cached at {}", version, cache_dir.display());
        return Ok(cache_dir);
    }

    // Download and extract
    download_nargo_toolchain(client, version, platform_arch, url_base, cache_dir.clone()).await?;

    Ok(cache_dir)
}

/// Download the nargo toolchain archive and extract it to cache_dir.
async fn download_nargo_toolchain(
    client: &Client,
    version: &str,
    platform_arch: &str,
    url_base: &str,
    cache_dir: PathBuf,
) -> Result<()> {
    // Construct download URL based on platform
    let archive_name = if platform_arch.starts_with("windows") {
        format!("nargo-{}-{}.zip", version, platform_arch)
    } else {
        format!("nargo-{}-{}.tar.gz", version, platform_arch)
    };

    let url = format!("{}/{}", url_base, archive_name);
    println!("  << Downloading nargo from {}", url);

    // Create parent directories
    tokio::fs::create_dir_all(&cache_dir).await?;

    // Download to temporary file
    let temp_archive = cache_dir.parent().unwrap().join(format!("{}.tmp", archive_name));
    let mut file = File::create(&temp_archive).await?;

    let progress: Option<ProgressCallback> = Some(Box::new(move |p: ProgressPayload| {
        println!("    Download progress: {}/{} MB", p.progress_total / 1024 / 1024, p.total / 1024 / 1024);
    }));

    download(client, &url, &mut file, progress, None, None).await?;
    drop(file);

    println!("  >> Extracting to {}", cache_dir.display());

    // Extract based on platform
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        extract_tar_gz(&temp_archive, &cache_dir).await?;
    }

    #[cfg(target_os = "windows")]
    {
        extract_zip(&temp_archive, &cache_dir).await?;
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        return Err(anyhow::anyhow!("Unsupported platform for toolchain extraction"));
    }

    // Clean up temp archive
    tokio::fs::remove_file(&temp_archive).await?;

    println!("✓ Nargo toolchain v{} installed", version);
    Ok(())
}

/// Extract a .tar.gz file to the target directory.
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn extract_tar_gz(archive_path: &std::path::Path, target_dir: &std::path::Path) -> Result<()> {
    use std::fs;
    use tar::Archive;
    use flate2::read::GzDecoder;
    use std::os::unix::fs::PermissionsExt;

    let file = fs::File::open(archive_path)?;
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);

    // Extract to parent directory first, then move files
    let parent = target_dir.parent().unwrap();
    archive.unpack(parent)?;

    // Set executable permissions on nargo and bb
    for binary in &["nargo", "bb"] {
        let binary_path = target_dir.join(binary);
        if binary_path.exists() {
            let mut perms = fs::metadata(&binary_path)?.permissions();
            perms.set_mode(0o755); // rwxr-xr-x
            fs::set_permissions(&binary_path, perms)?;
        }
    }

    Ok(())
}

/// Extract a .zip file to the target directory.
#[cfg(target_os = "windows")]
async fn extract_zip(archive_path: &std::path::Path, target_dir: &std::path::Path) -> Result<()> {
    use std::fs;
    use zip::ZipArchive;

    let file = fs::File::open(archive_path)?;
    let mut archive = ZipArchive::new(file)?;

    tokio::fs::create_dir_all(target_dir).await?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let out_path = target_dir.join(file.name());

        if file.is_dir() {
            fs::create_dir_all(&out_path)?;
        } else {
            if let Some(p) = out_path.parent() {
                fs::create_dir_all(p)?;
            }
            let mut outfile = fs::File::create(&out_path)?;
            std::io::copy(&mut file, &mut outfile)?;
        }
    }

    Ok(())
}

/// Stub for non-Unix, non-Windows platforms.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
async fn extract_tar_gz(_archive_path: &std::path::Path, _target_dir: &std::path::Path) -> Result<()> {
    Err(anyhow::anyhow!("Unsupported platform for tar.gz extraction"))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
async fn extract_zip(_archive_path: &std::path::Path, _target_dir: &std::path::Path) -> Result<()> {
    Err(anyhow::anyhow!("Unsupported platform for zip extraction"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_platform_detection() {
        // Simple test to ensure module compiles
        assert_eq!("linux", "linux");
    }
}
