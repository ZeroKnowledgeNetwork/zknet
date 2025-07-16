use std::env;

fn map_platform_arch(os: &str, arch: &str) -> Result<String, String> {
    match (os, arch) {
        ("linux", "aarch64") => Ok("linux-arm64".into()),
        ("linux", "x86_64") => Ok("linux-x64".into()),
        ("macos", "aarch64") | ("macos", "x86_64") => Ok("macos".into()),
        ("windows", "x86_64") => Ok("windows-x64".into()),
        _other => Err(format!("{os} ({arch})")),
    }
}

/// Get the current OS and architecture from the environment in a supported ZKN format
pub fn get_platform_arch() -> Result<String, String> {
    map_platform_arch(env::consts::OS, env::consts::ARCH)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_known_mappings() {
        assert_eq!(map_platform_arch("linux", "x86_64"), Ok("linux-x64".into()));
        assert_eq!(
            map_platform_arch("linux", "aarch64"),
            Ok("linux-arm64".into())
        );
        assert_eq!(map_platform_arch("macos", "x86_64"), Ok("macos".into()));
        assert_eq!(map_platform_arch("macos", "aarch64"), Ok("macos".into()));
        assert_eq!(
            map_platform_arch("windows", "x86_64"),
            Ok("windows-x64".into())
        );
    }

    #[test]
    fn test_unsupported_platform() {
        let result = map_platform_arch("plan9", "mips");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported platform"));
    }

    #[test]
    fn test_get_platform_arch_matches_current_target() {
        let expected = map_platform_arch(env::consts::OS, env::consts::ARCH);
        assert_eq!(get_platform_arch(), expected);
    }
}
