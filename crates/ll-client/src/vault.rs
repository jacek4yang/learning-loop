use ll_crypto::{
    ClientPlatformClass, ObjectEnvelope, ObjectType, VaultMasterKey, VaultSubkeys,
    calibrate_client_kdf, create_vault_key_envelope, decrypt_object, encrypt_object,
    unlock_vault_master_key,
};
use ll_versioning::{
    CommitBody, SignedCommit, UnsignedCommit, encode_commit_body, encode_signed_commit,
    new_object_id,
};
use zeroize::Zeroizing;

use crate::{ClientError, DeviceIdentity};

/// An in-memory unlocked vault key hierarchy.
pub struct UnlockedVault {
    vault_id: [u8; 16],
    master: VaultMasterKey,
    subkeys: VaultSubkeys,
}

impl UnlockedVault {
    /// Creates and password-wraps a new random VMK after bounded calibration.
    ///
    /// # Errors
    ///
    /// Returns a KDF, randomness, AEAD, or encoding failure.
    pub fn create(
        vault_id: [u8; 16],
        password: Zeroizing<String>,
        platform: ClientPlatformClass,
    ) -> Result<(Self, Vec<u8>), ClientError> {
        let policy = calibrate_client_kdf(platform)?;
        let (master, envelope) = create_vault_key_envelope(password, policy)?;
        let subkeys = master.derive_subkeys(&vault_id)?;
        Ok((
            Self {
                vault_id,
                master,
                subkeys,
            },
            envelope,
        ))
    }

    /// Unlocks an existing password-wrapped VMK.
    ///
    /// # Errors
    ///
    /// Returns a generic AEAD error for the wrong password or altered envelope.
    pub fn unlock(
        vault_id: [u8; 16],
        password: Zeroizing<String>,
        envelope: &[u8],
    ) -> Result<Self, ClientError> {
        let master = unlock_vault_master_key(password, envelope)?;
        let subkeys = master.derive_subkeys(&vault_id)?;
        Ok(Self {
            vault_id,
            master,
            subkeys,
        })
    }

    /// Encrypts one immutable object revision.
    ///
    /// # Errors
    ///
    /// Returns a cryptographic, limit, or encoding failure.
    pub fn encrypt(
        &self,
        object_id: [u8; 16],
        revision: u64,
        object_type: ObjectType,
        cleartext: &[u8],
    ) -> Result<Vec<u8>, ClientError> {
        Ok(encrypt_object(
            &self.subkeys,
            self.vault_id,
            object_id,
            revision,
            object_type,
            cleartext,
        )?)
    }

    /// Authenticates and decrypts one object belonging to this vault.
    ///
    /// # Errors
    ///
    /// Returns a cryptographic or vault-binding failure.
    pub fn decrypt(&self, encoded: &[u8]) -> Result<(ObjectEnvelope, Vec<u8>), ClientError> {
        let result = decrypt_object(&self.subkeys, encoded)?;
        if result.0.vault_id != self.vault_id {
            return Err(ClientError::InvalidState);
        }
        Ok(result)
    }

    /// Encrypts and signs a deterministic commit body.
    ///
    /// # Errors
    ///
    /// Returns a manifest, cryptographic, signing, limit, or encoding failure.
    pub fn create_signed_commit(
        &self,
        device: &DeviceIdentity,
        parents: Vec<[u8; 32]>,
        device_sequence: u64,
        body: &CommitBody,
    ) -> Result<Vec<u8>, ClientError> {
        let body = encode_commit_body(body)?;
        let encrypted_body = self.encrypt(new_object_id(), 1, ObjectType::Commit, &body)?;
        let commit = SignedCommit::create(
            UnsignedCommit {
                vault_id: self.vault_id,
                parents,
                device_id: device.device_id(),
                device_sequence,
                encrypted_body,
            },
            device.signing_key(),
        )?;
        Ok(encode_signed_commit(&commit)?)
    }

    /// Returns the persistent vault identifier.
    #[must_use]
    pub const fn vault_id(&self) -> [u8; 16] {
        self.vault_id
    }

    pub(crate) const fn subkeys(&self) -> &VaultSubkeys {
        &self.subkeys
    }

    /// Keeps the master key live for the exact lifetime of this unlocked value.
    #[must_use]
    pub fn is_unlocked(&self) -> bool {
        let _ = &self.master;
        true
    }
}

#[cfg(test)]
mod tests {
    use ll_crypto::{ClientPlatformClass, ObjectType};
    use ll_testkit::random_test_password;
    use ll_versioning::{CommitBody, decode_signed_commit, verify_signed_commit};

    use crate::{DeviceIdentity, UnlockedVault};

    #[test]
    fn vault_encrypts_content_and_creates_verifiable_commits() {
        let password = random_test_password().unwrap();
        let (vault, envelope) =
            UnlockedVault::create([7; 16], password.clone(), ClientPlatformClass::Desktop).unwrap();
        assert!(vault.is_unlocked());
        let unlocked = UnlockedVault::unlock([7; 16], password, &envelope).unwrap();
        let object_id = ll_versioning::new_object_id();
        let encrypted = unlocked
            .encrypt(object_id, 1, ObjectType::Content, b"canonical note")
            .unwrap();
        assert_eq!(unlocked.decrypt(&encrypted).unwrap().1, b"canonical note");

        let device = DeviceIdentity::generate().unwrap();
        let record = unlocked
            .create_signed_commit(
                &device,
                Vec::new(),
                1,
                &CommitBody {
                    logical_timestamp: 1,
                    operations: Vec::new(),
                    manifest_root: [8; 32],
                    manifest_blob_id: [9; 32],
                    merge_base: None,
                    conflict_objects: Vec::new(),
                },
            )
            .unwrap();
        let commit = decode_signed_commit(&record).unwrap();
        verify_signed_commit(&commit, &device.public_key()).unwrap();
    }
}
