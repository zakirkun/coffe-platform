//! Runner secrets: the revocable runner token and the libsodium-compatible key pairs
//! (Ed25519 identity, X25519 sealed-box recipient). Files are private to the OS user.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use coffe_protocol::RunnerPublicKeys;
use dryoc::classic::crypto_box::crypto_box_keypair;
use dryoc::classic::crypto_generichash::crypto_generichash;
use dryoc::classic::crypto_sign::{crypto_sign_detached, crypto_sign_keypair};
use serde::{Deserialize, Serialize};

const TOKEN_FILE: &str = "runner-token";
const SIGN_KEY_FILE: &str = "sign-key.json";
const BOX_KEY_FILE: &str = "box-key.json";

const SIGN_PUBLIC_LEN: usize = 32;
const SIGN_SECRET_LEN: usize = 64;
const SIGN_SIGNATURE_LEN: usize = 64;
const BOX_KEY_LEN: usize = 32;
/// BLAKE2b output length of the key fingerprint (§14.2).
const FINGERPRINT_BYTES: usize = 20;

#[derive(Debug, thiserror::Error)]
pub enum SecretsError {
    #[error("secrets store: {0}")]
    Io(#[from] io::Error),
    #[error("secret file {file} is corrupt: {reason}")]
    Corrupt { file: String, reason: String },
    #[error("cryptographic operation failed: {0}")]
    Crypto(String),
}

/// The runner's key material. The secret halves never leave the secrets directory.
#[derive(Clone)]
pub struct RunnerKeys {
    sign_public: [u8; SIGN_PUBLIC_LEN],
    sign_secret: [u8; SIGN_SECRET_LEN],
    box_public: [u8; BOX_KEY_LEN],
    box_secret: [u8; BOX_KEY_LEN],
}

impl RunnerKeys {
    pub fn generate() -> Self {
        let (sign_public, sign_secret) = crypto_sign_keypair();
        let (box_public, box_secret) = crypto_box_keypair();
        Self { sign_public, sign_secret, box_public, box_secret }
    }

    pub fn sign_public_key(&self) -> &[u8; SIGN_PUBLIC_LEN] {
        &self.sign_public
    }

    /// Public keys as sent in `pair` / `hello`; the box key is signed with the identity key.
    pub fn public_keys(&self) -> Result<RunnerPublicKeys, SecretsError> {
        let mut signature = [0u8; SIGN_SIGNATURE_LEN];
        crypto_sign_detached(&mut signature, &self.box_public, &self.sign_secret)
            .map_err(|err| SecretsError::Crypto(err.to_string()))?;
        Ok(RunnerPublicKeys {
            box_public_key: BASE64.encode(self.box_public),
            sign_public_key: BASE64.encode(self.sign_public),
            box_key_signature: BASE64.encode(signature),
        })
    }

    pub fn fingerprint(&self) -> Result<String, SecretsError> {
        fingerprint(&self.sign_public)
    }
}

/// Human-checkable fingerprint of an Ed25519 public key: BLAKE2b-160, RFC 4648 base32 without
/// padding (32 characters), shown as 8 groups of 4.
pub fn fingerprint(sign_public_key: &[u8]) -> Result<String, SecretsError> {
    let mut digest = [0u8; FINGERPRINT_BYTES];
    crypto_generichash(&mut digest, sign_public_key, None)
        .map_err(|err| SecretsError::Crypto(err.to_string()))?;
    let encoded = base32_nopad(&digest);
    let mut grouped = String::with_capacity(encoded.len() + encoded.len() / 4);
    for (index, ch) in encoded.chars().enumerate() {
        if index > 0 && index % 4 == 0 {
            grouped.push(' ');
        }
        grouped.push(ch);
    }
    Ok(grouped)
}

/// RFC 4648 base32 (upper-case alphabet), no padding.
pub fn base32_nopad(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(char::from(ALPHABET[((buffer >> bits) & 0x1f) as usize]));
        }
        buffer &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(char::from(ALPHABET[((buffer << (5 - bits)) & 0x1f) as usize]));
    }
    out
}

#[derive(Serialize, Deserialize)]
struct KeyFile {
    public: String,
    secret: String,
}

/// Secrets directory (`0700`, files `0600` on Unix).
#[derive(Debug, Clone)]
pub struct SecretStore {
    dir: PathBuf,
}

impl SecretStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn load_token(&self) -> Result<Option<String>, SecretsError> {
        match fs::read_to_string(self.dir.join(TOKEN_FILE)) {
            Ok(text) => {
                let token = text.trim();
                Ok((!token.is_empty()).then(|| token.to_owned()))
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    pub fn save_token(&self, token: &str) -> Result<(), SecretsError> {
        self.write_private(TOKEN_FILE, token.as_bytes())
    }

    pub fn load_keys(&self) -> Result<Option<RunnerKeys>, SecretsError> {
        let (Some(sign), Some(boxed)) =
            (self.read_key_file(SIGN_KEY_FILE)?, self.read_key_file(BOX_KEY_FILE)?)
        else {
            return Ok(None);
        };
        Ok(Some(RunnerKeys {
            sign_public: decode_key(SIGN_KEY_FILE, &sign.public)?,
            sign_secret: decode_key(SIGN_KEY_FILE, &sign.secret)?,
            box_public: decode_key(BOX_KEY_FILE, &boxed.public)?,
            box_secret: decode_key(BOX_KEY_FILE, &boxed.secret)?,
        }))
    }

    /// Existing keys are kept so the fingerprint users pinned stays valid across re-pairing.
    pub fn load_or_create_keys(&self) -> Result<RunnerKeys, SecretsError> {
        if let Some(keys) = self.load_keys()? {
            return Ok(keys);
        }
        let keys = RunnerKeys::generate();
        self.write_key_file(SIGN_KEY_FILE, &keys.sign_public, &keys.sign_secret)?;
        self.write_key_file(BOX_KEY_FILE, &keys.box_public, &keys.box_secret)?;
        Ok(keys)
    }

    /// Removes the token and both key pairs (`unpair`).
    pub fn wipe(&self) -> Result<(), SecretsError> {
        for file in [TOKEN_FILE, SIGN_KEY_FILE, BOX_KEY_FILE] {
            match fs::remove_file(self.dir.join(file)) {
                Ok(()) => {}
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => return Err(err.into()),
            }
        }
        Ok(())
    }

    fn read_key_file(&self, name: &str) -> Result<Option<KeyFile>, SecretsError> {
        let text = match fs::read_to_string(self.dir.join(name)) {
            Ok(text) => text,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };
        serde_json::from_str(&text)
            .map(Some)
            .map_err(|err| SecretsError::Corrupt { file: name.to_owned(), reason: err.to_string() })
    }

    fn write_key_file(&self, name: &str, public: &[u8], secret: &[u8]) -> Result<(), SecretsError> {
        let file = KeyFile { public: BASE64.encode(public), secret: BASE64.encode(secret) };
        let json = serde_json::to_vec_pretty(&file)
            .map_err(|err| SecretsError::Corrupt { file: name.to_owned(), reason: err.to_string() })?;
        self.write_private(name, &json)
    }

    fn write_private(&self, name: &str, contents: &[u8]) -> Result<(), SecretsError> {
        fs::create_dir_all(&self.dir)?;
        restrict(&self.dir, 0o700)?;
        let path = self.dir.join(name);
        let tmp = self.dir.join(format!("{name}.tmp"));
        {
            let mut file = private_file(&tmp)?;
            file.write_all(contents)?;
            file.sync_all()?;
        }
        restrict(&tmp, 0o600)?;
        fs::rename(&tmp, &path)?;
        Ok(())
    }
}

fn decode_key<const N: usize>(file: &str, encoded: &str) -> Result<[u8; N], SecretsError> {
    let corrupt = |reason: String| SecretsError::Corrupt { file: file.to_owned(), reason };
    let bytes = BASE64.decode(encoded.trim()).map_err(|err| corrupt(err.to_string()))?;
    <[u8; N]>::try_from(bytes.as_slice())
        .map_err(|_| corrupt(format!("expected {N} key bytes, found {}", bytes.len())))
}

#[cfg(unix)]
fn private_file(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)
}

#[cfg(not(unix))]
fn private_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new().write(true).create(true).truncate(true).open(path)
}

#[cfg(unix)]
fn restrict(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

/// Windows keeps the profile directory ACLs; there is no mode to tighten.
#[cfg(not(unix))]
fn restrict(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use dryoc::classic::crypto_sign::crypto_sign_verify_detached;

    #[test]
    fn base32_matches_rfc4648_vectors() {
        let vectors = [
            ("", ""),
            ("f", "MY"),
            ("fo", "MZXQ"),
            ("foo", "MZXW6"),
            ("foob", "MZXW6YQ"),
            ("fooba", "MZXW6YTB"),
            ("foobar", "MZXW6YTBOI"),
        ];
        for (input, expected) in vectors {
            assert_eq!(base32_nopad(input.as_bytes()), expected, "input {input:?}");
        }
    }

    #[test]
    fn fingerprint_is_eight_groups_of_four_base32_characters() {
        let print = fingerprint(&[7u8; 32]).unwrap();
        let groups: Vec<&str> = print.split(' ').collect();
        assert_eq!(groups.len(), 8);
        for group in &groups {
            assert_eq!(group.len(), 4);
            assert!(group.chars().all(|c| c.is_ascii_uppercase() || ('2'..='7').contains(&c)));
        }
        // Deterministic, and sensitive to the key.
        assert_eq!(print, fingerprint(&[7u8; 32]).unwrap());
        assert_ne!(print, fingerprint(&[8u8; 32]).unwrap());
    }

    #[test]
    fn box_key_signature_verifies_against_the_identity_key() {
        let keys = RunnerKeys::generate();
        let public = keys.public_keys().unwrap();
        let box_key = BASE64.decode(&public.box_public_key).unwrap();
        let sign_key: [u8; 32] = BASE64.decode(&public.sign_public_key).unwrap().try_into().unwrap();
        let signature: [u8; 64] =
            BASE64.decode(&public.box_key_signature).unwrap().try_into().unwrap();
        assert_eq!(box_key.len(), 32);
        crypto_sign_verify_detached(&signature, &box_key, &sign_key).unwrap();
        let mut tampered = box_key.clone();
        tampered[0] ^= 1;
        assert!(crypto_sign_verify_detached(&signature, &tampered, &sign_key).is_err());
    }

    #[test]
    fn keys_and_token_persist_and_wipe() {
        let dir = tempfile::tempdir().unwrap();
        let store = SecretStore::new(dir.path().join("secrets"));
        assert!(store.load_token().unwrap().is_none());
        assert!(store.load_keys().unwrap().is_none());

        let created = store.load_or_create_keys().unwrap();
        let reloaded = store.load_or_create_keys().unwrap();
        assert_eq!(created.fingerprint().unwrap(), reloaded.fingerprint().unwrap());
        assert_eq!(created.public_keys().unwrap(), reloaded.public_keys().unwrap());

        store.save_token("coffe_rt_abc\n").unwrap();
        assert_eq!(store.load_token().unwrap().as_deref(), Some("coffe_rt_abc"));

        store.wipe().unwrap();
        assert!(store.load_token().unwrap().is_none());
        assert!(store.load_keys().unwrap().is_none());
        store.wipe().unwrap();
    }

    #[test]
    fn corrupt_key_files_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let store = SecretStore::new(dir.path().to_path_buf());
        store.load_or_create_keys().unwrap();
        std::fs::write(dir.path().join(SIGN_KEY_FILE), r#"{"public":"AAAA","secret":"AAAA"}"#)
            .unwrap();
        let err = store.load_keys().err().expect("short keys must be rejected");
        assert!(matches!(err, SecretsError::Corrupt { .. }), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn secret_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let secrets = dir.path().join("secrets");
        let store = SecretStore::new(secrets.clone());
        store.load_or_create_keys().unwrap();
        store.save_token("coffe_rt_x").unwrap();
        assert_eq!(std::fs::metadata(&secrets).unwrap().permissions().mode() & 0o777, 0o700);
        for file in [TOKEN_FILE, SIGN_KEY_FILE, BOX_KEY_FILE] {
            let mode = std::fs::metadata(secrets.join(file)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{file}");
        }
    }
}
