# Nargo Toolchain Integration

This document explains how the Noir/Nargo (`nargo`) and Barretenberg (`bb`) toolchain integration works in the zknet monorepo.

## Overview

The zknet project now automatically downloads and caches the Noir toolchain (`nargo` + `bb` binaries) when connecting to a network. Both the CLI and Tauri desktop clients support this feature.

### Key Features

- **Automatic Download**: Toolchain binaries are downloaded on first use
- **Version-Aware Caching**: Multiple versions can be cached without conflicts
- **Cross-Platform Support**: Handles macOS (ARM64/x86_64), Linux, and Windows
- **Parallel Downloads**: Toolchain downloads run in parallel with other network assets
- **Secure Distribution**: Downloaded over HTTPS from configured network URLs

## Architecture

### Shared Core Library (`libs/rs-core`)

The `toolchain` module in `libs/rs-core/src/toolchain.rs` contains the core download and extraction logic:

```rust
pub async fn verify_or_download(
    client: &Client,
    version: &str,
    platform_arch: &str,
    url_base: &str,
    cache_dir: PathBuf,
) -> Result<PathBuf>
```

This function:
1. Checks if the toolchain is already cached
2. Downloads the appropriate archive for the platform
3. Extracts binaries (`nargo` and `bb`) to the cache directory
4. Sets proper file permissions (executable on Unix, `.exe` extension on Windows)

### Storage Structure

Toolchain binaries are stored in a version-aware cache structure:

```
~/.local/share/zknet-client/  (Linux/macOS)
~/.cache/zknet-client/        (Windows)
├── toolchains/
│   └── noir/
│       └── {version}/
│           ├── nargo
│           └── bb
└── networks/
    └── {network_id}/
        ├── client.toml
        ├── services.json
        └── walletshield
```

### Configuration

Add toolchain URLs to your config files:

**`apps/client-cli/assets/config.json`** (production):
```json
{
  "apiListenAddress": "127.0.0.1:7000",
  "urlNetwork": "https://test.net.zknet.io",
  "walletshieldListenAddress": ":7070",
  "urlToolchains": "https://test.net.zknet.io/toolchains",
  "noirVersion": "0.1.0"
}
```

**`apps/client-cli/assets/config.local.json`** (local testing):
```json
{
  "apiListenAddress": "127.0.0.1:7000",
  "urlNetwork": "http://127.0.0.1:8000",
  "walletshieldListenAddress": ":7070",
  "urlToolchains": "http://127.0.0.1:8000/toolchains",
  "noirVersion": "0.1.0"
}
```

## Usage

### CLI (`apps/client-cli`)

The toolchain is automatically downloaded when connecting to a network:

```bash
cd apps/client-cli
cargo run -- 0x134FDD1
```

Output:
```
Starting zknet-client-cli v0.1.0 on linux-x86_64
🌐 Using PRODUCTION configuration
...
Downloading nargo toolchain...
  << https://test.net.zknet.io/toolchains/nargo-0.1.0-linux-x86_64.tar.gz
  >> ~/.local/share/zknet-client/toolchains/noir/0.1.0
    Download progress: 45/123 MB
✓ Nargo toolchain v0.1.0 installed
✓ Nargo v0.1.0 available at: ~/.local/share/zknet-client/toolchains/noir/0.1.0
```

### Tauri Desktop Client (`apps/client`)

Three commands are available for the frontend:

#### 1. Download Toolchain
```javascript
// Trigger download from frontend
const result = await invoke('download_nargo_toolchain', {
  noirVersion: '0.1.0',
  platformArch: 'linux-x86_64',
  urlToolchains: 'https://test.net.zknet.io/toolchains'
});
// Returns: "Nargo v0.1.0 installed at: /path/to/cache"
```

#### 2. Get Toolchain Path
```javascript
const path = await invoke('get_nargo_path', {
  noirVersion: '0.1.0'
});
// Returns: "/home/user/.local/share/zknet-client/toolchains/noir/0.1.0"
```

#### 3. Execute Nargo Command
```javascript
const output = await invoke('run_nargo_command', {
  noirVersion: '0.1.0',
  args: ['--version']
});
// Returns stdout from nargo command
```

## Archive Format

The toolchain is distributed as platform-specific archives:

### Unix (macOS, Linux)
**Format**: `.tar.gz`  
**Filename**: `nargo-{version}-{platform_arch}.tar.gz`  
**Contents**:
```
nargo-0.1.0-linux-x86_64/
├── nargo
└── bb
```

**Example URL**: `https://test.net.zknet.io/toolchains/nargo-0.1.0-linux-x86_64.tar.gz`

### Windows
**Format**: `.zip`  
**Filename**: `nargo-{version}-{platform_arch}.zip`  
**Contents**:
```
nargo-0.1.0-windows-x86_64/
├── nargo.exe
└── bb.exe
```

**Example URL**: `https://test.net.zknet.io/toolchains/nargo-0.1.0-windows-x86_64.zip`

## Platform Detection

The toolchain module automatically detects the platform and downloads the appropriate binary:

| Platform | `platform_arch` | Archive Type |
|----------|-----------------|--------------|
| macOS (Apple Silicon) | `macos-aarch64` | `.tar.gz` |
| macOS (Intel) | `macos-x86_64` | `.tar.gz` |
| Linux | `linux-x86_64` | `.tar.gz` |
| Linux (ARM) | `linux-aarch64` | `.tar.gz` |
| Windows | `windows-x86_64` | `.zip` |

## GitHub Actions Release Pipeline

The `.github/workflows/client-publish-to-auto-release.yml` workflow includes a `build-nargo-binaries` job that:

1. **Triggers**: On `client@*` version tags (e.g., `client@0.2.0`)
2. **Builds**: Creates platform-specific archives for:
   - macOS ARM64 (`macos-arm64`)
   - macOS x86_64 (`macos-x86_64`)
   - Linux (`linux-x86_64`)
   - Windows (`windows-x86_64`)
3. **Uploads**: Attaches archives to the GitHub Release
4. **Names**: `nargo-{version}-{platform_name}.{tar.gz|zip}`

### Current Implementation

The workflow currently creates **placeholder binaries** (empty files). To use real Noir binaries:

**Option 1**: Download pre-built Noir releases from GitHub
```bash
# Fetch from: https://github.com/noir-lang/noir/releases
curl -L https://github.com/noir-lang/noir/releases/download/v0.1.0/nargo-linux-x86_64.tar.gz
```

**Option 2**: Build Noir from source in the workflow
```yaml
- name: Build Noir from source
  run: |
    git clone https://github.com/noir-lang/noir.git
    cd noir
    cargo build --release --target x86_64-unknown-linux-gnu
```

## Troubleshooting

### Toolchain Not Found

**Error**: `Nargo v0.1.0 not found`

**Solution**:
1. Check config has correct `urlToolchains` and `noirVersion`
2. Verify the network server has the archive at the expected URL
3. Check network connectivity
4. Manually download: 
   ```bash
   curl https://test.net.zknet.io/toolchains/nargo-0.1.0-linux-x86_64.tar.gz
   ```

### Download Timeout

**Error**: `Download failed: operation timed out`

**Solution**:
1. Increase the timeout in `libs/rs-core/src/lib.rs` (currently 60s)
2. Check network speed: `time curl -O <archive-url>`
3. Try a smaller test file first

### Permission Denied

**Error**: `Permission denied` when running nargo

**Solution**:
1. Manual fix:
   ```bash
   chmod +x ~/.local/share/zknet-client/toolchains/noir/0.1.0/nargo
   chmod +x ~/.local/share/zknet-client/toolchains/noir/0.1.0/bb
   ```
2. Check cache directory exists and is readable

### Wrong Platform Binary Downloaded

**Error**: Downloaded binary incompatible with system

**Solution**:
1. Verify platform detection: `cargo run -- 0x134FDD1` shows platform in first line
2. Clear cache and retry: `rm -rf ~/.local/share/zknet-client/toolchains/noir/{version}`
3. Check `platform_arch` matches archive filename

## Development

### Adding Support for New Platforms

1. **Update platform detection** in `libs/rs-core/src/utils.rs`:
   ```rust
   fn get_platform_arch() -> Result<String> {
       // Add new platform case
   }
   ```

2. **Update archive extraction** in `libs/rs-core/src/toolchain.rs`:
   ```rust
   #[cfg(target_os = "new_platform")]
   async fn extract_tar_gz(...) { ... }
   ```

3. **Update workflow** in `.github/workflows/client-publish-to-auto-release.yml`:
   ```yaml
   matrix:
     include:
       - platform_name: 'new-platform'
         args: '--target new-platform-target'
   ```

### Testing Locally

1. **Start a local toolchain server**:
   ```bash
   mkdir -p /tmp/toolchains
   cd /tmp/toolchains
   # Add archives here: nargo-0.1.0-*.tar.gz
   python3 -m http.server 8000
   ```

2. **Use local config**:
   ```bash
   cargo run -- 0x134FDD1 --local
   # Uses http://127.0.0.1:8000/toolchains
   ```

3. **Monitor downloads**:
   ```bash
   tail -f ~/.local/share/zknet-client/logs/app.log
   ```

## Integration with Circuits

Once the toolchain is cached, you can use it to compile Noir circuits:

```bash
NARGO_PATH=~/.local/share/zknet-client/toolchains/noir/0.1.0/nargo
$NARGO_PATH compile --acir-as-unconstrained
```

Or through the Tauri API:
```javascript
const output = await invoke('run_nargo_command', {
  noirVersion: '0.1.0',
  args: ['compile', '--acir-as-unconstrained']
});
```

## Future Enhancements

- [ ] Verify downloaded binaries using GPG signatures
- [ ] Support downloading circuits alongside toolchain
- [ ] Cache multiple versions simultaneously with automatic cleanup
- [ ] WebAssembly version of Noir for in-browser compilation
- [ ] Progress bar UI in desktop client
- [ ] Custom Noir version per network deployment
