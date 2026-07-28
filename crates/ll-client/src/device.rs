use ed25519_dalek::{Signer, SigningKey};
use ll_crypto::{ObjectType, decrypt_object, encrypt_object, random_array};
use zeroize::{Zeroize, Zeroizing};

use crate::{ClientError, UnlockedVault};

const DEVICE_SECRET_VERSION: u8 = 1;
const DEVICE_SECRET_BYTES: usize = 49;

/// A client-held Ed25519 device identity.
pub struct DeviceIdentity {
    device_id: [u8; 16],
    signing_key: SigningKey,
}

impl DeviceIdentity {
    /// Generates a random signing key and a `UUIDv7` device identifier.
    ///
    /// # Errors
    ///
    /// Returns an OS randomness failure.
    pub fn generate() -> Result<Self, ClientError> {
        Ok(Self {
            device_id: ll_versioning::new_object_id(),
            signing_key: SigningKey::from_bytes(&random_array::<32>()?),
        })
    }

    /// Restores an identity from an authenticated recovery object.
    ///
    /// # Errors
    ///
    /// Returns a cryptographic or deterministic-format failure.
    pub fn from_encrypted(vault: &UnlockedVault, encoded: &[u8]) -> Result<Self, ClientError> {
        let (envelope, mut clear) = decrypt_object(vault.subkeys(), encoded)?;
        if envelope.vault_id != vault.vault_id()
            || envelope.object_id == [0; 16]
            || envelope.revision != 1
            || envelope.object_type != ObjectType::Recovery
            || clear.len() != DEVICE_SECRET_BYTES
            || clear[0] != DEVICE_SECRET_VERSION
        {
            clear.zeroize();
            return Err(ClientError::InvalidState);
        }
        let device_id: [u8; 16] = clear[1..17]
            .try_into()
            .map_err(|_| ClientError::InvalidLength)?;
        if device_id != envelope.object_id {
            clear.zeroize();
            return Err(ClientError::InvalidState);
        }
        let seed = Zeroizing::new(
            clear[17..]
                .try_into()
                .map_err(|_| ClientError::InvalidLength)?,
        );
        clear.zeroize();
        Ok(Self {
            device_id,
            signing_key: SigningKey::from_bytes(&seed),
        })
    }

    /// Encrypts the signing seed under the vault recovery subkey.
    ///
    /// # Errors
    ///
    /// Returns a cryptographic or encoding failure.
    pub fn encrypt_for_storage(&self, vault: &UnlockedVault) -> Result<Vec<u8>, ClientError> {
        let mut clear = Zeroizing::new([0_u8; DEVICE_SECRET_BYTES]);
        clear[0] = DEVICE_SECRET_VERSION;
        clear[1..17].copy_from_slice(&self.device_id);
        clear[17..].copy_from_slice(&self.signing_key.to_bytes());
        Ok(encrypt_object(
            vault.subkeys(),
            vault.vault_id(),
            self.device_id,
            1,
            ObjectType::Recovery,
            clear.as_ref(),
        )?)
    }

    /// Returns the stable device identifier.
    #[must_use]
    pub const fn device_id(&self) -> [u8; 16] {
        self.device_id
    }

    /// Returns the public verification key.
    #[must_use]
    pub fn public_key(&self) -> [u8; 32] {
        self.signing_key.verifying_key().to_bytes()
    }

    pub(crate) fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.signing_key.sign(message).to_bytes()
    }

    pub(crate) const fn signing_key(&self) -> &SigningKey {
        &self.signing_key
    }
}

#[cfg(test)]
mod tests {
    use ll_crypto::{ClientPlatformClass, ObjectType};
    use ll_testkit::random_test_password;

    use super::DeviceIdentity;
    use crate::UnlockedVault;

    #[test]
    fn device_secret_round_trips_only_inside_vault_encryption() {
        let password = random_test_password().unwrap();
        let (vault, _) =
            UnlockedVault::create([1; 16], password, ClientPlatformClass::Desktop).unwrap();
        let device = DeviceIdentity::generate().unwrap();
        let encrypted = device.encrypt_for_storage(&vault).unwrap();
        let envelope = ll_crypto::decode_object_envelope(&encrypted).unwrap();
        assert_eq!(envelope.object_type, ObjectType::Recovery);
        assert!(
            !encrypted
                .windows(32)
                .any(|window| window == device.public_key())
        );
        let restored = DeviceIdentity::from_encrypted(&vault, &encrypted).unwrap();
        assert_eq!(restored.device_id(), device.device_id());
        assert_eq!(restored.public_key(), device.public_key());
    }
}
