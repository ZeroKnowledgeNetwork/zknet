//! What vouches for a network's binaries before a client runs them.
//!
//! A build's WalletShield binaries are listed with their sha256 in
//! `checksums.txt`, and the list is signed with minisign as
//! `checksums.txt.minisig`; both are published beside each network's assets.
//! A client trusts one key, compiled in from `asset-key.pub` (one line: the
//! base64 public key, the line `minisign -G` writes second), the key a
//! build's list is signed with. Changing it is a one-line commit and a
//! client release; nothing at runtime can replace it.
//!
//! [`Vouched`] is the seam: it is what the network code consumes, so another
//! way of vouching for a build only has to produce one.

use std::{collections::BTreeMap, io::Read, path::Path};

use minisign_verify::{PublicKey, Signature};
use sha2::{Digest, Sha256};

/// The signed list of a build's binaries, as `sha256sum` writes it.
pub const SIGNED_LIST: &str = "checksums.txt";
/// The list's minisign signature.
pub const SIGNATURE: &str = "checksums.txt.minisig";

/// The clients' asset key: one line, the public half of the signing key.
const ASSET_KEY: &str = include_str!("../asset-key.pub");

/// What a signature's trusted comment starts with. Anything else this key
/// signs can't pass for a list of binaries.
const DOMAIN: &str = "zknet-assets v1 ";

/// What a client trusts to vouch for binaries.
#[derive(Clone, Debug)]
pub enum TrustRoot {
    /// One minisign key.
    Minisign { key: PublicKey, key_id: String },
}

impl TrustRoot {
    /// The compiled-in root.
    pub fn builtin() -> Self {
        Self::minisign(ASSET_KEY).expect("asset-key.pub holds a minisign public key")
    }

    /// A root of one minisign public key, in base64 as `minisign -G` writes it.
    pub fn minisign(public_key: &str) -> Result<Self, AuthError> {
        let public_key = public_key.trim();
        let key = PublicKey::from_base64(public_key)
            .map_err(|_| AuthError::Malformed { what: "public key" })?;
        let key_id = key_id_from(public_key).ok_or(AuthError::Malformed { what: "public key" })?;
        Ok(TrustRoot::Minisign { key, key_id })
    }

    /// The key id as minisign prints it, e.g. `3ECC6455C6F297BC`.
    pub fn key_id(&self) -> &str {
        let TrustRoot::Minisign { key_id, .. } = self;
        key_id
    }

    /// Check a signed list against this root, and return what it vouches for.
    pub fn vouch(&self, list: &[u8], signature: &str) -> Result<Vouched, AuthError> {
        let TrustRoot::Minisign { key, key_id } = self;
        let sig =
            Signature::decode(signature).map_err(|_| AuthError::Malformed { what: SIGNATURE })?;
        key.verify(list, &sig, false).map_err(|e| match e {
            minisign_verify::Error::UnexpectedKeyId => AuthError::WrongKey {
                got: signature
                    .lines()
                    .nth(1)
                    .and_then(|l| key_id_from(l.trim()))
                    .unwrap_or_else(|| "?".into()),
                want: key_id.clone(),
            },
            _ => AuthError::BadSignature {
                key: key_id.clone(),
            },
        })?;

        let fields = sig
            .trusted_comment()
            .strip_prefix(DOMAIN)
            .ok_or(AuthError::NotAnAssetList)?;
        let build = fields
            .split(' ')
            .find_map(|f| f.strip_prefix("build="))
            .filter(|b| !b.is_empty())
            .ok_or(AuthError::Malformed {
                what: "trusted comment",
            })?
            .to_owned();

        let text =
            std::str::from_utf8(list).map_err(|_| AuthError::Malformed { what: SIGNED_LIST })?;
        let mut files = BTreeMap::new();
        for line in text.lines().filter(|l| !l.is_empty()) {
            let (hash, name) = line
                .split_once("  ")
                .or_else(|| line.split_once(" *"))
                .ok_or(AuthError::Malformed { what: SIGNED_LIST })?;
            let hash = parse_sha256(hash).ok_or(AuthError::Malformed { what: SIGNED_LIST })?;
            files.insert(name.to_owned(), hash);
        }
        Ok(Vouched { build, files })
    }
}

/// One build's vouched hashes, by the file name each binary is published as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Vouched {
    /// `build=` from the signature's trusted comment, e.g. `v0.4.3-424-gfe69171`.
    pub build: String,
    files: BTreeMap<String, [u8; 32]>,
}

impl Vouched {
    /// Check that a staged file holds the vouched bytes of the name it was
    /// published as.
    pub fn check(&self, published_name: &str, staged: &Path) -> Result<(), AuthError> {
        let want = self
            .files
            .get(published_name)
            .ok_or_else(|| AuthError::NotListed {
                file: published_name.to_owned(),
            })?;
        let got = sha256_file(staged).map_err(|_| AuthError::Malformed {
            what: "staged file",
        })?;
        if &got == want {
            return Ok(());
        }
        Err(AuthError::Mismatch {
            got: short(&got),
            want: short(want),
            is: self
                .files
                .iter()
                .find(|(_, h)| **h == got)
                .map(|(f, _)| f.clone()),
        })
    }
}

/// How a client treats a source's signatures.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    Require,
    /// A dev-local source in a debug build may serve an unsigned set.
    AllowUnsignedLocal,
}

impl Policy {
    /// The policy for `base_url` when unsigned assets are asked for
    /// (`--allow-unsigned`, `allowUnsigned`): granted only to a loopback
    /// source, and only in a debug build.
    pub fn for_source(base_url: &str, allow_unsigned: bool) -> Result<Policy, AuthError> {
        decide(base_url, allow_unsigned, cfg!(debug_assertions))
    }
}

fn decide(base_url: &str, allow_unsigned: bool, debug: bool) -> Result<Policy, AuthError> {
    if !allow_unsigned {
        return Ok(Policy::Require);
    }
    if !debug {
        return Err(AuthError::OverrideRefused(
            "unsigned assets are allowed only in a debug build".into(),
        ));
    }
    let url = reqwest::Url::parse(base_url).ok();
    let host = url.as_ref().and_then(|u| u.host_str()).unwrap_or(base_url);
    let ip = host.trim_start_matches('[').trim_end_matches(']');
    let loopback = host == "localhost"
        || ip
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if loopback {
        Ok(Policy::AllowUnsignedLocal)
    } else {
        Err(AuthError::OverrideRefused(format!(
            "unsigned assets are allowed only from a local source (127.0.0.1, ::1 or localhost), not {host}"
        )))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("the source publishes no signature ({SIGNATURE})")]
    Unsigned,
    #[error("the asset list is signed by key {got}, not by this client's key {want}")]
    WrongKey { got: String, want: String },
    #[error("the asset list's signature is invalid for key {key}")]
    BadSignature { key: String },
    #[error("the signature is not for a zknet asset list")]
    NotAnAssetList,
    #[error("the signed asset list has no {file}")]
    NotListed { file: String },
    #[error(
        "its sha256 is {got}, but the signed asset list says {want}{}",
        is.as_ref().map_or(String::new(), |f| format!(" (these are the bytes of {f})"))
    )]
    Mismatch {
        got: String,
        want: String,
        is: Option<String>,
    },
    #[error("malformed {what}")]
    Malformed { what: &'static str },
    #[error("{0}")]
    OverrideRefused(String),
}

/// A minisign key id from a base64 public key or signature line (bytes 2..10),
/// printed as minisign does: big-endian hex of the little-endian id.
fn key_id_from(b64: &str) -> Option<String> {
    let bin = base64_decode(b64)?;
    let id = bin.get(2..10)?;
    Some(id.iter().rev().map(|b| format!("{b:02X}")).collect())
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in s.trim_end_matches('=').bytes() {
        let v = ALPHABET.iter().position(|&a| a == c)? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn parse_sha256(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(2 * i..2 * i + 2)?, 16).ok()?;
    }
    Some(out)
}

fn sha256_file(path: &Path) -> std::io::Result<[u8; 32]> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().into())
}

/// The first 16 hex digits: enough to tell two hashes apart in a message.
fn short(hash: &[u8; 32]) -> String {
    hash[..8].iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway signer: a fresh minisign key pair per test.
    pub(crate) struct Signer {
        pk: minisign::PublicKey,
        sk: minisign::SecretKey,
    }

    impl Signer {
        pub(crate) fn new() -> Self {
            let minisign::KeyPair { pk, sk } =
                minisign::KeyPair::generate_unencrypted_keypair().unwrap();
            Self { pk, sk }
        }

        pub(crate) fn root(&self) -> TrustRoot {
            TrustRoot::minisign(&self.pk.to_base64()).unwrap()
        }

        pub(crate) fn sign(&self, list: &[u8], trusted: &str) -> String {
            minisign::sign(
                Some(&self.pk),
                &self.sk,
                std::io::Cursor::new(list),
                Some(trusted),
                Some("signature from a test key"),
            )
            .unwrap()
            .to_string()
        }
    }

    const TRUSTED: &str =
        "zknet-assets v1 build=v0.4.3-424-gfe69171 commit=fe69171 timestamp:1793042057";

    fn list(entries: &[(&str, &[u8])]) -> Vec<u8> {
        entries
            .iter()
            .map(|(name, bytes)| {
                let h: [u8; 32] = Sha256::digest(bytes).into();
                let hex: String = h.iter().map(|b| format!("{b:02x}")).collect();
                format!("{hex}  {name}\n")
            })
            .collect::<String>()
            .into_bytes()
    }

    fn staged(bytes: &[u8]) -> tempfile::NamedTempFile {
        let f = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(f.path(), bytes).unwrap();
        f
    }

    #[test]
    fn the_builtin_key_is_one_line_and_parses() {
        assert_eq!(ASSET_KEY.trim_end().lines().count(), 1);
        let root = TrustRoot::builtin();
        assert_eq!(root.key_id().len(), 16);
    }

    #[test]
    fn key_ids_print_as_minisign_prints_them() {
        // `minisign -G` printed: "untrusted comment: minisign public key 62CC253B30FB9E29"
        let root = TrustRoot::minisign("RWQpnvswOyXMYhrtlNOB1eufImrhQWyOF96DxBG2odLhAeo3e9ICzKu7")
            .unwrap();
        assert_eq!(root.key_id(), "62CC253B30FB9E29");
    }

    #[test]
    fn a_signed_list_vouches_for_its_files() {
        let signer = Signer::new();
        let l = list(&[
            ("walletshield-linux-x64", b"x64"),
            ("walletshield-linux-arm64", b"arm"),
        ]);
        let vouched = signer.root().vouch(&l, &signer.sign(&l, TRUSTED)).unwrap();
        assert_eq!(vouched.build, "v0.4.3-424-gfe69171");
        vouched
            .check("walletshield-linux-x64", staged(b"x64").path())
            .unwrap();
    }

    #[test]
    fn a_tampered_file_is_refused() {
        let signer = Signer::new();
        let l = list(&[("walletshield-linux-x64", b"x64")]);
        let v = signer.root().vouch(&l, &signer.sign(&l, TRUSTED)).unwrap();
        let e = v
            .check("walletshield-linux-x64", staged(b"x64!").path())
            .unwrap_err();
        assert!(matches!(e, AuthError::Mismatch { is: None, .. }), "{e}");
        assert!(e.to_string().starts_with("its sha256 is "), "{e}");
    }

    #[test]
    fn another_platforms_bytes_are_named() {
        let signer = Signer::new();
        let l = list(&[
            ("walletshield-linux-x64", b"x64"),
            ("walletshield-linux-arm64", b"arm"),
        ]);
        let v = signer.root().vouch(&l, &signer.sign(&l, TRUSTED)).unwrap();
        let e = v
            .check("walletshield-linux-x64", staged(b"arm").path())
            .unwrap_err();
        assert!(
            e.to_string()
                .ends_with("(these are the bytes of walletshield-linux-arm64)"),
            "{e}"
        );
    }

    #[test]
    fn an_unlisted_file_is_refused() {
        let signer = Signer::new();
        let l = list(&[("walletshield-linux-x64", b"x64")]);
        let v = signer.root().vouch(&l, &signer.sign(&l, TRUSTED)).unwrap();
        let e = v
            .check("walletshield-macos-arm64", staged(b"x64").path())
            .unwrap_err();
        assert_eq!(
            e.to_string(),
            "the signed asset list has no walletshield-macos-arm64"
        );
    }

    #[test]
    fn another_key_is_refused_by_id() {
        let (ours, theirs) = (Signer::new(), Signer::new());
        let l = list(&[("walletshield-linux-x64", b"x64")]);
        let e = ours
            .root()
            .vouch(&l, &theirs.sign(&l, TRUSTED))
            .unwrap_err();
        let want = format!(
            "the asset list is signed by key {}, not by this client's key {}",
            theirs.root().key_id(),
            ours.root().key_id()
        );
        assert_eq!(e.to_string(), want);
    }

    #[test]
    fn an_edited_list_is_refused() {
        let signer = Signer::new();
        let l = list(&[("walletshield-linux-x64", b"x64")]);
        let sig = signer.sign(&l, TRUSTED);
        let edited = list(&[("walletshield-linux-x64", b"evil")]);
        let e = signer.root().vouch(&edited, &sig).unwrap_err();
        assert!(matches!(e, AuthError::BadSignature { .. }), "{e}");
    }

    #[test]
    fn an_edited_trusted_comment_is_refused() {
        let signer = Signer::new();
        let l = list(&[("walletshield-linux-x64", b"x64")]);
        let sig = signer
            .sign(&l, TRUSTED)
            .replace("build=v0.4.3-424-gfe69171", "build=v9.9.9");
        let e = signer.root().vouch(&l, &sig).unwrap_err();
        assert!(matches!(e, AuthError::BadSignature { .. }), "{e}");
    }

    #[test]
    fn a_signature_for_something_else_is_refused() {
        let signer = Signer::new();
        let l = list(&[("walletshield-linux-x64", b"x64")]);
        let e = signer
            .root()
            .vouch(
                &l,
                &signer.sign(&l, "timestamp:1793042057\tfile:checksums.txt\thashed"),
            )
            .unwrap_err();
        assert!(matches!(e, AuthError::NotAnAssetList), "{e}");
    }

    #[test]
    fn malformed_inputs_are_refused() {
        let signer = Signer::new();
        let l = list(&[("walletshield-linux-x64", b"x64")]);
        assert!(matches!(
            signer.root().vouch(&l, "not a signature"),
            Err(AuthError::Malformed { what: SIGNATURE })
        ));
        let bad = b"nothex  walletshield-linux-x64\n";
        assert!(matches!(
            signer.root().vouch(bad, &signer.sign(bad, TRUSTED)),
            Err(AuthError::Malformed { what: SIGNED_LIST })
        ));
        assert!(matches!(
            signer
                .root()
                .vouch(&l, &signer.sign(&l, "zknet-assets v1 commit=fe69171")),
            Err(AuthError::Malformed {
                what: "trusted comment"
            })
        ));
        assert!(TrustRoot::minisign("nope").is_err());
    }

    #[test]
    fn unsigned_is_allowed_only_for_a_loopback_source_in_a_debug_build() {
        for url in [
            "http://127.0.0.1:8765",
            "http://[::1]:8765",
            "http://localhost:8765",
        ] {
            assert_eq!(
                decide(url, true, true).unwrap(),
                Policy::AllowUnsignedLocal,
                "{url}"
            );
            assert_eq!(decide(url, false, true).unwrap(), Policy::Require, "{url}");
            assert_eq!(
                decide(url, true, false).unwrap_err().to_string(),
                "unsigned assets are allowed only in a debug build"
            );
        }
        for url in [
            "https://dist.zknet.io/networks",
            "http://192.168.1.2:8765",
            "http://localhost.evil:1",
        ] {
            let e = decide(url, true, true).unwrap_err().to_string();
            assert!(
                e.starts_with("unsigned assets are allowed only from a local source"),
                "{e}"
            );
            assert_eq!(decide(url, false, true).unwrap(), Policy::Require);
        }
        assert_eq!(
            decide("https://dist.zknet.io/networks", true, true).unwrap_err().to_string(),
            "unsigned assets are allowed only from a local source (127.0.0.1, ::1 or localhost), not dist.zknet.io"
        );
    }
}
