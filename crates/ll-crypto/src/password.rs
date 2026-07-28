use argon2::{Algorithm, Argon2, Params, Version};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::CryptoError;

const AUTH_CONTEXT_LABEL: &[u8] = b"learning-loop/server-auth/v1";
const VERIFIER_LABEL: &[u8] = b"learning-loop/server-auth-verifier/v1";

/// Persisted Argon2id parameters for server access authentication.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Argon2Policy {
    /// Memory in KiB.
    pub memory_kib: u32,
    /// Iterations.
    pub iterations: u32,
    /// Parallel lanes.
    pub parallelism: u32,
}

impl Argon2Policy {
    /// Conservative production server policy.
    pub const SERVER_DEFAULT: Self = Self {
        memory_kib: 65_536,
        iterations: 3,
        parallelism: 1,
    };

    /// Constructs the `RustCrypto` Argon2id instance.
    ///
    /// # Errors
    ///
    /// Returns [`CryptoError::InvalidArgon2Policy`] for invalid or unsafe
    /// parameters.
    pub fn argon2(self) -> Result<Argon2<'static>, CryptoError> {
        if self.memory_kib < 19_456
            || self.memory_kib > 262_144
            || self.iterations == 0
            || self.iterations > 10
            || self.parallelism == 0
            || self.parallelism > 4
        {
            return Err(CryptoError::InvalidArgon2Policy);
        }
        let params = Params::new(self.memory_kib, self.iterations, self.parallelism, Some(32))
            .map_err(|_| CryptoError::InvalidArgon2Policy)?;
        Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
    }
}

/// Zeroizing server-password-derived authentication key.
pub struct ServerAuthKey(Zeroizing<[u8; 32]>);

impl ServerAuthKey {
    /// Returns the key only for HMAC/verifier operations inside trusted code.
    #[must_use]
    pub fn expose(&self) -> &[u8; 32] {
        &self.0
    }
}

impl Clone for ServerAuthKey {
    fn clone(&self) -> Self {
        Self(Zeroizing::new(*self.0))
    }
}

/// Derives the server authentication key with Argon2id.
///
/// # Errors
///
/// Returns a [`CryptoError`] for invalid parameters or derivation failure.
pub fn derive_server_auth_key(
    password: &[u8],
    salt: &[u8; 16],
    policy: Argon2Policy,
) -> Result<ServerAuthKey, CryptoError> {
    let mut output = Zeroizing::new([0_u8; 32]);
    policy
        .argon2()?
        .hash_password_into(password, salt, output.as_mut())
        .map_err(|_| CryptoError::Argon2)?;
    Ok(ServerAuthKey(output))
}

/// Computes a persistent verifier for startup password consistency.
#[must_use]
pub fn server_auth_verifier(auth_key: &ServerAuthKey) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(VERIFIER_LABEL);
    hasher.update(auth_key.expose());
    *hasher.finalize().as_bytes()
}

/// Checks a persistent verifier in constant time.
///
/// # Errors
///
/// Returns [`CryptoError::AuthenticationFailed`] for a mismatch.
pub fn verify_server_auth_verifier(
    auth_key: &ServerAuthKey,
    expected: &[u8; 32],
) -> Result<(), CryptoError> {
    let actual = server_auth_verifier(auth_key);
    if bool::from(actual.ct_eq(expected)) {
        Ok(())
    } else {
        Err(CryptoError::AuthenticationFailed)
    }
}

/// Builds the domain-separated session authentication context.
#[must_use]
pub fn authentication_context(
    handshake_hash: &[u8],
    challenge: &[u8; 32],
    session_id: &[u8; 16],
) -> Vec<u8> {
    let mut context = Vec::with_capacity(AUTH_CONTEXT_LABEL.len() + handshake_hash.len() + 32 + 16);
    context.extend_from_slice(AUTH_CONTEXT_LABEL);
    context.extend_from_slice(handshake_hash);
    context.extend_from_slice(challenge);
    context.extend_from_slice(session_id);
    context
}

/// Computes the HMAC-SHA-256 password proof.
///
/// # Panics
///
/// Panics only if the HMAC implementation rejects a 32-byte key, which
/// HMAC-SHA-256 accepts by definition.
#[must_use]
pub fn password_proof(auth_key: &ServerAuthKey, context: &[u8]) -> [u8; 32] {
    let mut hmac = Hmac::<Sha256>::new_from_slice(auth_key.expose())
        .expect("HMAC-SHA-256 accepts a 32-byte key");
    hmac.update(context);
    hmac.finalize().into_bytes().into()
}

/// Verifies a password proof without a timing-sensitive equality comparison.
///
/// # Errors
///
/// Returns [`CryptoError::AuthenticationFailed`] for a mismatch.
///
/// # Panics
///
/// Panics only if the HMAC implementation rejects a 32-byte key, which
/// HMAC-SHA-256 accepts by definition.
pub fn verify_password_proof(
    auth_key: &ServerAuthKey,
    context: &[u8],
    proof: &[u8; 32],
) -> Result<(), CryptoError> {
    let mut hmac = Hmac::<Sha256>::new_from_slice(auth_key.expose())
        .expect("HMAC-SHA-256 accepts a 32-byte key");
    hmac.update(context);
    hmac.verify_slice(proof)
        .map_err(|_| CryptoError::AuthenticationFailed)
}

#[cfg(test)]
mod tests {
    use super::{
        Argon2Policy, authentication_context, derive_server_auth_key, password_proof,
        server_auth_verifier, verify_password_proof, verify_server_auth_verifier,
    };

    const TEST_POLICY: Argon2Policy = Argon2Policy {
        memory_kib: 19_456,
        iterations: 1,
        parallelism: 1,
    };

    #[test]
    fn proof_and_verifier_reject_different_passwords() {
        let salt = [7_u8; 16];
        let password = crate::random_array::<32>().unwrap();
        let other_password = crate::random_array::<32>().unwrap();
        let key = derive_server_auth_key(&password, &salt, TEST_POLICY).unwrap();
        let other = derive_server_auth_key(&other_password, &salt, TEST_POLICY).unwrap();
        let context = authentication_context(&[1; 32], &[2; 32], &[3; 16]);
        let proof = password_proof(&key, &context);

        verify_password_proof(&key, &context, &proof).unwrap();
        assert!(verify_password_proof(&other, &context, &proof).is_err());
        let verifier = server_auth_verifier(&key);
        verify_server_auth_verifier(&key, &verifier).unwrap();
        assert!(verify_server_auth_verifier(&other, &verifier).is_err());
    }
}
