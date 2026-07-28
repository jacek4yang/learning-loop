use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use base32ct::{Base32Unpadded, Encoding};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

use crate::{CryptoError, random_array};

const PRIVATE_KEY_FILE: &str = "server-identity.key";
const PUBLIC_KEY_FILE: &str = "server-identity.pub";

/// Persistent server Noise identity and display fingerprint.
pub struct ServerIdentity {
    private_key: Zeroizing<[u8; 32]>,
    public_key: [u8; 32],
    fingerprint: String,
}

impl ServerIdentity {
    /// Loads or creates a fixed X25519 responder identity in `data_dir`.
    ///
    /// A private key is created with exclusive file creation and restrictive
    /// Unix permissions. An existing public-key mismatch fails closed.
    ///
    /// # Errors
    ///
    /// Returns a [`CryptoError`] for randomness, I/O, truncation, or a public
    /// key inconsistent with the persistent private key.
    pub fn load_or_create(data_dir: &Path) -> Result<Self, CryptoError> {
        fs::create_dir_all(data_dir)?;
        let private_path = data_dir.join(PRIVATE_KEY_FILE);
        let public_path = data_dir.join(PUBLIC_KEY_FILE);

        let mut private_key = if private_path.exists() {
            Zeroizing::new(read_exact_file::<32>(&private_path)?)
        } else {
            let generated = Zeroizing::new(random_array::<32>()?);
            write_new_file(&private_path, generated.as_ref(), true)?;
            generated
        };

        let secret = StaticSecret::from(*private_key);
        let derived_public = PublicKey::from(&secret).to_bytes();
        let public_key = if public_path.exists() {
            let persisted = read_exact_file::<32>(&public_path)?;
            if !bool::from(persisted.ct_eq(&derived_public)) {
                private_key.zeroize();
                return Err(CryptoError::InvalidIdentity);
            }
            persisted
        } else {
            write_new_file(&public_path, &derived_public, false)?;
            derived_public
        };

        let fingerprint = fingerprint(&public_key);
        Ok(Self {
            private_key,
            public_key,
            fingerprint,
        })
    }

    /// Returns the persistent responder private key for a mature Noise library.
    #[must_use]
    pub fn private_key(&self) -> &[u8; 32] {
        &self.private_key
    }

    /// Returns the persistent responder public key.
    #[must_use]
    pub const fn public_key(&self) -> &[u8; 32] {
        &self.public_key
    }

    /// Returns `SHA256:` plus uppercase unpadded base32 of the public key hash.
    #[must_use]
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}

fn fingerprint(public_key: &[u8; 32]) -> String {
    let digest = Sha256::digest(public_key);
    format!(
        "SHA256:{}",
        Base32Unpadded::encode_string(&digest).to_uppercase()
    )
}

fn read_exact_file<const N: usize>(path: &Path) -> Result<[u8; N], CryptoError> {
    let mut file = File::open(path)?;
    let mut output = [0_u8; N];
    file.read_exact(&mut output)?;
    let mut trailing = [0_u8; 1];
    if file.read(&mut trailing)? != 0 {
        output.zeroize();
        return Err(CryptoError::InvalidIdentity);
    }
    Ok(output)
}

fn write_new_file(path: &PathBuf, contents: &[u8], private: bool) -> Result<(), CryptoError> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    set_private_mode(&mut options, private);
    let mut file = options.open(path)?;
    file.write_all(contents)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(unix)]
fn set_private_mode(options: &mut OpenOptions, private: bool) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(if private { 0o600 } else { 0o644 });
}

#[cfg(not(unix))]
fn set_private_mode(_options: &mut OpenOptions, _private: bool) {}

#[cfg(test)]
mod tests {
    use super::ServerIdentity;

    #[test]
    fn identity_and_fingerprint_survive_restart() {
        let directory = tempfile::tempdir().unwrap();
        let first = ServerIdentity::load_or_create(directory.path()).unwrap();
        let public = *first.public_key();
        let fingerprint = first.fingerprint().to_owned();
        drop(first);

        let second = ServerIdentity::load_or_create(directory.path()).unwrap();
        assert_eq!(*second.public_key(), public);
        assert_eq!(second.fingerprint(), fingerprint);
    }
}
