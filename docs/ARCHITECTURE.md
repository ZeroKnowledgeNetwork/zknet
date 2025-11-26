# ZKNet Architecture & Deployment Diagram

## High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ZKNet Monorepo                                     │
│                      (Nx + Rust + TypeScript)                               │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                        APPLICATIONS LAYER                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐  │
│  │  Desktop Client      │  │  CLI Client          │  │  Browser Ext     │  │
│  │  (Tauri + React)     │  │  (Rust Binary)       │  │  (Wxt + React)   │  │
│  │                      │  │                      │  │                  │  │
│  │  - UI Wallet Mgmt    │  │  - Network Setup     │  │  - DApp Bridge   │  │
│  │  - Interactive Proofs│  │  - Nargo Config      │  │  - Quick Actions │  │
│  │  - RPC Endpoints     │  │  - Proof Generation  │  │  - Injected API  │  │
│  │  - Settings          │  │  - Binary Download   │  │                  │  │
│  │                      │  │                      │  │                  │  │
│  └──────────────────────┘  └──────────────────────┘  └──────────────────┘  │
│          ↑ Tauri IPC             ↑ CLI Exec              ↑ Message API      │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                        SHARED LIBRARIES LAYER                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ rs-core (Rust Library @ libs/rs-core)                                 │ │
│  ├────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                         │ │
│  │  [Core Modules]                          [Toolchain Integration]      │ │
│  │  ├── config.rs ─────┬─ Load app config   ├── toolchain.rs            │ │
│  │  │                  │  - URLs, versions  │   - Download nargo/bb     │ │
│  │  │                  │  - Cache settings  │   - Platform detection    │ │
│  │  │                  └─ JSON merge        │   - Archive extraction    │ │
│  │  │                                       │   - Permission handling   │ │
│  │  ├── paths.rs ──────┬─ Platform paths    │   - Cache management     │ │
│  │  │                  │  - Cache dirs      │   - Parallel downloads   │ │
│  │  │                  │  - Data dirs       │                          │ │
│  │  │                  └─ XDG compliance    │  [Architecture]           │ │
│  │  │                                       │  - verify_or_download()   │ │
│  │  ├── context.rs ────┬─ App context       │  - extract_tar_gz()      │ │
│  │  │                  │  - Paths & Config  │  - extract_zip()         │ │
│  │  │                  │  - Platform info   │  - run_command()         │ │
│  │  │                  └─ Serialization     │                          │ │
│  │  │                                       │                          │ │
│  │  ├── net.rs ────────┬─ Network logic     │  [Dependencies]           │ │
│  │  │                  │  - WalletShield    │  - reqwest (HTTP)         │ │
│  │  │                  │  - Nargo download  │  - tokio (async)          │ │
│  │  │                  │  - Parallel DL     │  - tar/flate2 (Unix)      │ │
│  │  │                  │  - ToolchainInfo   │  - zip (Windows)          │ │
│  │  │                  └─ Error handling    │                          │ │
│  │  │                                                                    │ │
│  │  └── utils.rs ──── Helpers & utilities                               │ │
│  │                                                                         │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ @zknet/sdk (TypeScript Library @ packages/sdk)                        │ │
│  ├────────────────────────────────────────────────────────────────────────┤ │
│  │ - WS-RPC client for zknet protocol                                    │ │
│  │ - Type definitions & interfaces                                       │ │
│  │ - Proof generation helpers                                            │ │
│  │                                                                         │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                      EXTERNAL SERVICES & NETWORKS                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐  │
│  │  GitHub Releases     │  │  ZKNet Protocol      │  │  Blockchain RPC  │  │
│  │  (Noir Binaries)     │  │  (WS/WebSocket)      │  │  (Ethereum, etc) │  │
│  │                      │  │                      │  │                  │  │
│  │  nargo-v*.tar.gz     │  │  - Network proofs    │  │  - JSON-RPC      │  │
│  │  nargo-v*.zip        │  │  - State updates     │  │  - Web3 standard │  │
│  │  bb-v*.tar.gz        │  │  - Event streams     │  │  - Smart contracts
│  │  bb-v*.zip           │  │  - Protocol msgs     │  │                  │  │
│  │                      │  │                      │  │                  │  │
│  └──────────────────────┘  └──────────────────────┘  └──────────────────┘  │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Interaction Diagram

```
                    ┌────────────────────────────────────┐
                    │     End User (Developer)            │
                    └────────────┬─────────────────────────┘
                                 │
                    ┌────────────┴─────────────────────────┐
                    │                                      │
          ┌─────────▼──────────┐            ┌─────────────▼─────────┐
          │   Desktop Client   │            │    CLI Tool           │
          │   (Tauri App)      │            │    (zknet-cli)        │
          │                    │            │                       │
          │  ┌──────────────┐  │            │  ┌────────────────┐  │
          │  │ React UI     │  │            │  │ Main.rs        │  │
          │  └──────┬───────┘  │            │  └────────┬───────┘  │
          │         │          │            │           │          │
          │  ┌──────▼───────┐  │            │  ┌────────▼───────┐  │
          │  │ Tauri Cmds   │  │            │  │ Network Setup  │  │
          │  └──────┬───────┘  │            │  └────────┬───────┘  │
          │         │          │            │           │          │
          └────┬────┼──────────┘            └─────┬─────┼──────────┘
               │    │                             │     │
               │    └──────────────────┬──────────┘     │
               │                       │                │
               │         ┌─────────────▼────────────┐   │
               │         │                          │   │
               └────────→│     rs-core Library      │←──┘
                         │                          │
                         ├──────────────────────────┤
                         │  Config (urls, versions) │
                         │  Paths (cache dirs)      │
                         │  Context (app state)     │
                         │  Network (connect, DL)   │
                         │  Toolchain (nargo, bb)   │
                         │  Utils (helpers)         │
                         │                          │
                         └──────────────┬───────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
          ┌─────────▼──────────┐  ┌─────▼────────┐  ┌────▼──────────┐
          │  Local Cache       │  │  GitHub      │  │  ZKNet        │
          │  ~/.../toolchains/ │  │  Releases    │  │  Servers      │
          │  ~/.../networks/   │  │  (Binaries)  │  │  (WS-RPC)     │
          │                    │  │              │  │               │
          │  - nargo/version/  │  │ nargo-*.tar  │  │ network.rs    │
          │  - bb/version/     │  │ bb-*.tar.gz  │  │ walletshield  │
          │  - network configs │  │              │  │               │
          │                    │  │              │  │               │
          └────────────────────┘  └──────────────┘  └───────────────┘
```

## Deployment Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                    DEVELOPMENT ENVIRONMENT                             │
├────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Local Machine (macOS/Linux/Windows)                                   │
│  ├── Nx Workspace (pnpm)                                               │
│  │   ├── @zknet/client (Tauri)                                         │
│  │   ├── @zknet/client-cli (Rust)                                      │
│  │   ├── @zknet/ext (Browser extension)                                │
│  │   ├── @zknet/sdk (TypeScript library)                               │
│  │   └── rs-core (Rust library)                                        │
│  │                                                                       │
│  ├── Cache Directories                                                  │
│  │   ├── ~/.../toolchains/noir/0.1.0/                                  │
│  │   │   ├── nargo (executable)                                        │
│  │   │   └── bb (executable)                                           │
│  │   └── ~/.../networks/{network_id}/                                  │
│  │                                                                       │
│  └── Test Infrastructure                                               │
│      ├── tests/server.js (Node.js HTTP server on :8000)                │
│      ├── tests/mock-network/0x134FDD1/                                 │
│      │   ├── client.toml                                               │
│      │   └── services.json                                             │
│      └── tests/mock-toolchain/                                         │
│          ├── nargo-0.1.0-linux-x86_64.tar.gz                           │
│          ├── nargo-0.1.0-macos-aarch64.tar.gz                          │
│          └── nargo-0.1.0-windows-x86_64.zip                            │
│                                                                          │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                    PRODUCTION DEPLOYMENT                               │
├────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Build & Release Pipeline (GitHub Actions)                             │
│  ├── Step 1: Build Noir Binaries (build-nargo-binaries job)           │
│  │   ├── Compile nargo for: linux-x86_64, macos-{x86_64,aarch64}     │
│  │   └── Compile bb for: linux-x86_64, macos-{x86_64,aarch64}        │
│  │                                                                       │
│  ├── Step 2: Create Release Assets                                    │
│  │   ├── Archive as .tar.gz (Unix)                                    │
│  │   ├── Archive as .zip (Windows)                                    │
│  │   └── Upload to GitHub Releases                                    │
│  │                                                                       │
│  ├── Step 3: Distribute Application Binaries                          │
│  │   ├── CLI: zknet-cli-*.tar.gz / zknet-cli-*.zip                   │
│  │   ├── Desktop: app-*.dmg (macOS), app-*.exe (Windows)             │
│  │   └── Extension: manifest.json + bundled .zip                     │
│  │                                                                       │
│  └── Step 4: Update Configuration                                      │
│      └── Set url_toolchains to GitHub Releases CDN URL                │
│                                                                          │
│  Production Distribution Channels                                       │
│  ├── GitHub Releases (All binaries)                                    │
│  ├── Browser Extension Store                                           │
│  └── Package registries (npm for SDK)                                  │
│                                                                          │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                    END-USER RUNTIME ENVIRONMENT                         │
├────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Desktop User                                                            │
│  ├── 1. Download zknet-app-*.dmg from GitHub Releases                  │
│  ├── 2. Install & run (Tauri app)                                      │
│  ├── 3. On first connect():                                            │
│  │   ├── Check ~/.../toolchains/noir/0.1.0/                           │
│  │   ├── If missing: Download nargo-*.tar.gz from GitHub Releases     │
│  │   ├── Extract to cache directory                                   │
│  │   └── Set executable permissions                                   │
│  └── 4. Use nargo cached binary for proof generation                  │
│                                                                          │
│  CLI User                                                                │
│  ├── 1. Download zknet-cli-*.tar.gz from GitHub Releases              │
│  ├── 2. Extract & add to PATH                                         │
│  ├── 3. Run: zknet-cli connect                                        │
│  ├── 4. Tool automatically:                                           │
│  │   ├── Detects platform (linux-x86_64 or macos-aarch64)            │
│  │   ├── Downloads nargo binary if needed                            │
│  │   └── Returns path for proof generation                           │
│  └── 5. Use for network setup & configuration                         │
│                                                                          │
│  Browser User                                                            │
│  ├── 1. Install extension from Chrome/Firefox store                   │
│  ├── 2. Extension injects zknet API into page.window                  │
│  ├── 3. DApps can call window.zknet.* methods                         │
│  ├── 4. Extension communicates with background.ts service worker     │
│  └── 5. Uses @zknet/sdk for proof generation & submission             │
│                                                                          │
└────────────────────────────────────────────────────────────────────────┘
```

## Data Flow: Toolchain Download & Execution

```
┌─────────────────┐
│  User starts    │
│  app / runs CLI │
└────────┬────────┘
         │
         ▼
    ┌────────────────────────────────────┐
    │ network_connect() called            │
    │ (from lib.rs)                       │
    └────────┬───────────────────────────┘
             │
             ▼
    ┌───────────────────────────────────────────┐
    │ Load AppConfig                            │
    │ - url_toolchains: String                  │
    │ - noir_version: String                    │
    │ - platform: linux-x86_64 / macos-* / win  │
    └────────┬────────────────────────────────┘
             │
    ┌────────┴─────────────────────────────┐
    │ tokio::try_join!() - Parallel DL     │
    ▼                                      ▼
┌─────────────────────┐        ┌────────────────────────┐
│ download nargo      │        │ download walletshield  │
│                     │        │                        │
│ 1. Check cache:     │        │ 1. Check cache:        │
│    verify_or_       │        │    verify_or_download()│
│    download()       │        │                        │
│                     │        │ 2. DL from url         │
│ 2. DL from:         │        │    (parallel request)  │
│    {url_toolchains}│        │                        │
│    /nargo-{v}-     │        │ 3. Extract & cache     │
│    {platform}.tar  │        │                        │
│                     │        │ 4. Return path         │
│ 3. Extract to:      │        │                        │
│    ~/.../toolchain │        │                        │
│    s/noir/{v}/     │        │                        │
│                     │        │                        │
│ 4. Set perms +x     │        │                        │
│                     │        │                        │
│ 5. Return path      │        │                        │
└──────────┬──────────┘        └──────────┬─────────────┘
           │                             │
           └──────────────┬──────────────┘
                          │
                          ▼
               ┌────────────────────┐
               │ Return ToolchainInfo
               │ {                  │
               │  noir_cache_dir    │
               │  noir_version      │
               │ }                  │
               └────────┬───────────┘
                        │
                        ▼
        ┌───────────────────────────────────┐
        │ Desktop Client                    │
        │ - Display in UI                   │
        │ - Show version & path             │
        │ - Ready for proof generation      │
        └────────────────────────────────────┘
```

## Project Structure & Dependencies

```
zknet_main/
│
├── 📦 Package Management
│   ├── package.json ────── Root workspace config (pnpm)
│   ├── pnpm-workspace.yaml - Monorepo definition
│   └── pnpm-lock.yaml ----- Locked dependency versions
│
├── ⚙️  Nx Configuration
│   ├── nx.json ------------ Nx settings & plugins
│   ├── tsconfig.base.json - Shared TypeScript config
│   └── jest.config.ts ----- Jest test configuration
│
├── 📚 Shared Libraries
│   │
│   ├── libs/rs-core/ (Rust Library)
│   │   ├── src/
│   │   │   ├── lib.rs ---------- Entry point
│   │   │   ├── config.rs ------- Configuration loading
│   │   │   ├── paths.rs ------- Platform-aware paths
│   │   │   ├── context.rs ----- App context
│   │   │   ├── net.rs --------- Network operations
│   │   │   ├── toolchain.rs --- Toolchain download/extract
│   │   │   └── utils.rs ------- Utilities
│   │   ├── tests/ ------------- Integration tests
│   │   └── Cargo.toml -------- Rust dependencies
│   │
│   └── packages/sdk/ (TypeScript Library)
│       ├── src/
│       │   ├── index.ts ------- Public API
│       │   └── lib/ ----------- Implementation
│       ├── tsconfig.lib.json
│       └── package.json
│
├── 🖥️  Applications
│   │
│   ├── apps/client/ (Desktop - Tauri)
│   │   ├── src/ (React)
│   │   │   ├── main.tsx ------- Entry point
│   │   │   ├── App.tsx -------- Root component
│   │   │   ├── components/ --- UI components
│   │   │   ├── pages/ -------- Page components
│   │   │   ├── services/ ----- API services
│   │   │   └── store/ ------- State management
│   │   │
│   │   ├── src-tauri/ (Rust backend)
│   │   │   ├── src/
│   │   │   │   ├── main.rs ----- Tauri entry point
│   │   │   │   ├── lib.rs ------ Registered commands
│   │   │   │   ├── toolchain.rs- Toolchain commands
│   │   │   │   ├── ws_server.rs- WebSocket server
│   │   │   │   └── config.rs --- Backend config
│   │   │   │
│   │   │   └── Cargo.toml ---- Rust dependencies
│   │   │
│   │   ├── vite.config.ts ---- Frontend build config
│   │   └── tauri.conf.json --- Tauri app config
│   │
│   ├── apps/client-cli/ (CLI - Rust)
│   │   ├── src/
│   │   │   └── main.rs ------- CLI entry point
│   │   ├── assets/
│   │   │   ├── config.json ------ Production config
│   │   │   └── config.local.json - Local dev config
│   │   └── Cargo.toml ------ Rust dependencies
│   │
│   ├── apps/ext/ (Browser Extension)
│   │   ├── entrypoints/
│   │   │   ├── background.ts --- Service worker
│   │   │   ├── content.ts ------ Content script
│   │   │   ├── injected.ts ----- Injected script
│   │   │   └── popup/App.tsx --- Popup UI
│   │   ├── src/
│   │   │   ├── types.ts ------ Type definitions
│   │   │   ├── config.ts ----- Extension config
│   │   │   ├── ws-rpc-client.ts
│   │   │   └── messaging/ ---- IPC messaging
│   │   ├── wxt.config.ts ---- Wxt build config
│   │   └── package.json
│   │
│   └── apps/demo/ (Demo App)
│       ├── src/
│       ├── vite.config.ts
│       └── package.json
│
├── 🧪 Testing Infrastructure
│   ├── tests/
│   │   ├── README.md -------------- Test documentation
│   │   ├── server.js -------------- Node.js HTTP server
│   │   ├── mock-network/ --------- Mock network fixtures
│   │   │   └── 0x134FDD1/
│   │   │       ├── client.toml
│   │   │       └── services.json
│   │   └── mock-toolchain/ ------- Mock binary fixtures
│   │       ├── nargo-0.1.0-linux-x86_64.tar.gz
│   │       ├── nargo-0.1.0-macos-aarch64.tar.gz
│   │       └── nargo-0.1.0-windows-x86_64.zip
│   │
│   ├── jest.config.ts ------- Jest configuration
│   └── jest.preset.js ------- Jest preset
│
├── 📋 CI/CD & Configuration
│   ├── .github/workflows/
│   │   ├── ci.yml ---------------------- Main CI pipeline
│   │   └── client-publish-to-auto-release.yml
│   │
│   ├── Cargo.toml ----------- Rust workspace config
│   ├── cliff.toml --------- Changelog config
│   ├── eslint.config.mjs -- ESLint config
│   ├── tsconfig.json ------ TypeScript config
│   └── nx.json ------------- Nx configuration
│
├── 📖 Documentation
│   ├── README.md ---------- Project overview
│   ├── ARCHITECTURE.md --- This file
│   ├── TOOLCHAIN_README.md - Toolchain guide
│   └── LICENSE
│
└── Configuration
    └── pnpm-workspace.yaml
```

## Key Data Structures

### AppConfig (from config.rs)
```rust
pub struct AppConfig {
    pub url_walletshield: String,      // e.g., "http://127.0.0.1:8000/mock-network/0x134FDD1"
    pub url_toolchains: String,         // e.g., "http://127.0.0.1:8000/mock-toolchain"
    pub noir_version: String,           // e.g., "0.1.0"
    pub network_id: String,             // e.g., "0x134FDD1"
}
```

### AppPaths (from paths.rs)
```rust
pub struct AppPaths {
    pub data_dir: PathBuf,              // Platform-aware data directory
    pub config_dir: PathBuf,            // Platform-aware config directory
    pub log_dir: PathBuf,               // Platform-aware log directory
    // Methods:
    // pub fn dir_toolchains() -> PathBuf
    // pub fn dir_noir_cache(version: &str) -> PathBuf
    // pub fn dir_networks() -> PathBuf
}
```

### ToolchainInfo (from lib.rs)
```rust
pub struct ToolchainInfo {
    pub noir_cache_dir: PathBuf,        // Path to cached nargo binary
    pub noir_version: String,           // Version string
}
```

## Deployment Checklist

- [ ] **Development**
  - [ ] `pnpm install` - Install dependencies
  - [ ] `cargo check --all` - Verify compilation
  - [ ] `pnpm run test:server` - Start mock test server
  - [ ] `npx nx run-many -t test` - Run all tests

- [ ] **Building**
  - [ ] `npx nx build @zknet/client` - Build Tauri desktop app
  - [ ] `npx nx build zknet_client_cli` - Build CLI binary
  - [ ] `npx nx build @zknet/ext` - Build browser extension
  - [ ] `npx nx build @zknet/sdk` - Build TypeScript SDK

- [ ] **Release**
  - [ ] GitHub Actions builds Noir binaries
  - [ ] Upload binaries to GitHub Releases
  - [ ] CLI downloads from releases automatically
  - [ ] Desktop app extracts cached nargo on first run
  - [ ] Extension bundled with SDK

- [ ] **End User**
  - [ ] Download from GitHub Releases
  - [ ] First run triggers toolchain download
  - [ ] Cached in `~/.zknet/toolchains/noir/{version}/`
  - [ ] Binary remains available for offline use

## Technology Stack Summary

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | React 19 + TypeScript | UI layer |
| **Desktop** | Tauri 2 | Cross-platform app |
| **Extension** | Wxt 0.20 + React | Browser extension |
| **Backend** | Rust 2021 | Core logic |
| **Async** | Tokio 1.46 | Async runtime |
| **HTTP** | Reqwest 0.12 | HTTP client |
| **Archives** | tar/flate2/zip | Cross-platform compression |
| **Monorepo** | Nx 21.2.2 | Task orchestration |
| **Build** | Vite/esbuild | Frontend build |
| **Package** | pnpm 10.10 | Package manager |
| **Testing** | Jest 30 | JavaScript tests |
| **Linting** | ESLint 9 + Rust Clippy | Code quality |

