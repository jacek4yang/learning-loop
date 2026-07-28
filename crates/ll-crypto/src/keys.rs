use std::time::Duration;

use argon2::{Algorithm, Argon2, Params, Version};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::CryptoError;

const CONTENT_LABEL: &[u8] = b"learning-loop/vmk/content/v1";
const PATH_LABEL: &[u8] = b"learning-loop/vmk/path/v1";
const METADATA_LABEL: &[u8] = b"learning-loop/vmk/metadata/v1";
const COMMIT_LABEL: &[u8] = b"learning-loop/vmk/commit/v1";
const ATTACHMENT_LABEL: &[u8] = b"learning-loop/vmk/attachment/v1";
const RECOVERY_LABEL: &[u8] = b"learning-loop/vmk/recovery/v1";

/// Random 256-bit root key that exists only on unlocked clients.
pub struct VaultMasterKey(SecretKey);

impl VaultMasterKey {
    /// Generates a random 256-bit vault master key.
    ///
    /// # Errors
    ///
    /// Returns [`CryptoError::Random`] if OS randomness is unavailable.
    pub fn generate() -> Result<Self, CryptoError> {
        Ok(Self::from_bytes(crate::random_array::<32>()?))
    }

    /// Imports authenticated recovery bytes into a zeroizing VMK container.
    ///
    /// The caller must obtain these bytes only by decrypting and authenticating
    /// a recovery artifact. The input allocation is zeroized after the move.
    #[must_use]
    pub fn from_recovery_bytes(bytes: Zeroizing<[u8; 32]>) -> Self {
        Self(SecretKey(bytes))
    }

    pub(crate) fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(SecretKey::new(bytes))
    }

    pub(crate) fn expose(&self) -> &[u8; 32] {
        self.0.expose()
    }

    /// Derives all versioned, domain-separated vault subkeys.
    ///
    /// # Errors
    ///
    /// Returns [`CryptoError::KeyDerivation`] if HKDF rejects a fixed-size
    /// expansion.
    pub fn derive_subkeys(&self, vault_id: &[u8; 16]) -> Result<VaultSubkeys, CryptoError> {
        let hkdf = Hkdf::<Sha256>::new(Some(vault_id), self.expose());
        Ok(VaultSubkeys {
            content: expand(&hkdf, CONTENT_LABEL)?,
            path: expand(&hkdf, PATH_LABEL)?,
            metadata: expand(&hkdf, METADATA_LABEL)?,
            commit: expand(&hkdf, COMMIT_LABEL)?,
            attachment: expand(&hkdf, ATTACHMENT_LABEL)?,
            recovery: expand(&hkdf, RECOVERY_LABEL)?,
        })
    }
}

impl Clone for VaultMasterKey {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

/// Six independently derived vault encryption domains.
pub struct VaultSubkeys {
    content: SecretKey,
    path: SecretKey,
    metadata: SecretKey,
    commit: SecretKey,
    attachment: SecretKey,
    recovery: SecretKey,
}

impl VaultSubkeys {
    pub(crate) fn key_for(&self, object_type: crate::ObjectType) -> &[u8; 32] {
        match object_type {
            crate::ObjectType::Content => self.content.expose(),
            crate::ObjectType::Path => self.path.expose(),
            crate::ObjectType::Metadata => self.metadata.expose(),
            crate::ObjectType::Commit => self.commit.expose(),
            crate::ObjectType::Attachment => self.attachment.expose(),
            crate::ObjectType::Recovery => self.recovery.expose(),
        }
    }
}

/// Persistable, non-secret client Argon2id parameters.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ClientKdfPolicy {
    /// Memory in KiB.
    pub memory_kib: u32,
    /// Iteration count.
    pub iterations: u32,
    /// Parallel lanes.
    pub parallelism: u32,
}

impl ClientKdfPolicy {
    /// Lowest accepted memory setting, in KiB.
    pub const MIN_MEMORY_KIB: u32 = 19_456;
    /// Highest accepted desktop memory setting, in KiB.
    pub const MAX_DESKTOP_MEMORY_KIB: u32 = 256 * 1024;
    /// Highest accepted Android memory setting, in KiB.
    pub const MAX_ANDROID_MEMORY_KIB: u32 = 64 * 1024;

    pub(crate) fn argon2(self) -> Result<Argon2<'static>, CryptoError> {
        if self.memory_kib < Self::MIN_MEMORY_KIB
            || self.memory_kib > Self::MAX_DESKTOP_MEMORY_KIB
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

/// Performance class used for bounded client-side KDF calibration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClientPlatformClass {
    /// Windows, macOS, or Linux desktop.
    Desktop,
    /// Memory-constrained Android runtime.
    Android,
}

impl ClientPlatformClass {
    pub(crate) const fn initial_memory_kib(self) -> u32 {
        match self {
            Self::Desktop => 64 * 1024,
            Self::Android => 32 * 1024,
        }
    }

    pub(crate) const fn maximum_memory_kib(self) -> u32 {
        match self {
            Self::Desktop => ClientKdfPolicy::MAX_DESKTOP_MEMORY_KIB,
            Self::Android => ClientKdfPolicy::MAX_ANDROID_MEMORY_KIB,
        }
    }

    pub(crate) const fn target(self) -> Duration {
        match self {
            Self::Desktop => Duration::from_millis(500),
            Self::Android => Duration::from_millis(800),
        }
    }
}

#[derive(Clone)]
pub(crate) struct SecretKey(Zeroizing<[u8; 32]>);

impl SecretKey {
    pub(crate) fn new(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    pub(crate) fn expose(&self) -> &[u8; 32] {
        &self.0
    }
}

fn expand(hkdf: &Hkdf<Sha256>, label: &[u8]) -> Result<SecretKey, CryptoError> {
    let mut output = [0_u8; 32];
    hkdf.expand(label, &mut output)
        .map_err(|_| CryptoError::KeyDerivation)?;
    Ok(SecretKey::new(output))
}

pub(crate) fn select_calibrated_policy(
    platform: ClientPlatformClass,
    memory_kib: u32,
    measured: Duration,
) -> ClientKdfPolicy {
    let elapsed_micros = measured.as_micros().max(1);
    let target_micros = platform.target().as_micros();
    let iterations = target_micros.div_ceil(elapsed_micros).clamp(1, 10);
    ClientKdfPolicy {
        memory_kib: memory_kib.min(platform.maximum_memory_kib()),
        iterations: u32::try_from(iterations).unwrap_or(10),
        parallelism: 1,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{ClientKdfPolicy, ClientPlatformClass, VaultMasterKey, select_calibrated_policy};

    #[test]
    fn vault_subkeys_are_stable_and_domain_separated() {
        let master = VaultMasterKey::from_bytes([3; 32]);
        let first = master.derive_subkeys(&[4; 16]).unwrap();
        let second = master.derive_subkeys(&[4; 16]).unwrap();
        assert_eq!(
            first.key_for(crate::ObjectType::Content),
            second.key_for(crate::ObjectType::Content)
        );
        assert_ne!(
            first.key_for(crate::ObjectType::Content),
            first.key_for(crate::ObjectType::Path)
        );
    }

    #[test]
    fn calibration_selection_is_bounded_by_platform() {
        let android = select_calibrated_policy(
            ClientPlatformClass::Android,
            128 * 1024,
            Duration::from_millis(100),
        );
        assert_eq!(android.memory_kib, ClientKdfPolicy::MAX_ANDROID_MEMORY_KIB);
        assert_eq!(android.iterations, 8);
        let desktop = select_calibrated_policy(
            ClientPlatformClass::Desktop,
            64 * 1024,
            Duration::from_secs(2),
        );
        assert_eq!(desktop.iterations, 1);
    }
}
