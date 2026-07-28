//! Synthetic test data that is generated at runtime, never committed as a
//! credential or vault.

use ed25519_dalek::SigningKey;
use thiserror::Error;
use zeroize::Zeroizing;

/// Runtime-only test fixture creation failure.
#[derive(Debug, Error)]
pub enum TestkitError {
    /// Operating-system randomness failed.
    #[error("secure test randomness is unavailable")]
    Random(#[from] getrandom::Error),
}

/// Generates a random runtime-only test password.
///
/// # Errors
///
/// Returns [`TestkitError::Random`] when OS randomness is unavailable.
pub fn random_test_password() -> Result<Zeroizing<String>, TestkitError> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes)?;
    Ok(Zeroizing::new(hex::encode(bytes)))
}

/// Generates a runtime-only Ed25519 device signing key.
///
/// # Errors
///
/// Returns [`TestkitError::Random`] when OS randomness is unavailable.
pub fn random_device_signing_key() -> Result<SigningKey, TestkitError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(SigningKey::from_bytes(&bytes))
}

/// Generates a `UUIDv7` identifier for a synthetic test object.
#[must_use]
pub fn test_uuid() -> [u8; 16] {
    *uuid::Uuid::now_v7().as_bytes()
}
