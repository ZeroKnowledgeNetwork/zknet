//! WalletShield, the client each network publishes: the arguments both clients
//! run it with. It runs from the network's directory ([`Layout::network_dir`]),
//! where its config is [`CLIENT_TOML`]; each client spawns it its own way.
//!
//! [`Layout::network_dir`]: crate::network::Layout::network_dir

use crate::network::CLIENT_TOML;

/// WalletShield's arguments. It picks its mode (full or thin) from the
/// network's config, so no argument chooses it.
pub fn args(listen_address: &str, log_level: &str) -> Vec<String> {
    [
        "-listen",
        listen_address,
        "-config",
        CLIENT_TOML,
        "-log_level",
        log_level,
    ]
    .map(String::from)
    .to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_leave_the_mode_to_the_config() {
        assert_eq!(
            args(":7070", "INFO"),
            [
                "-listen",
                ":7070",
                "-config",
                "client.toml",
                "-log_level",
                "INFO"
            ]
        );
        assert!(!args(":7070", "DEBUG").iter().any(|a| a == "-thin"));
    }
}
