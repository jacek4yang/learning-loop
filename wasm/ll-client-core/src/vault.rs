use ll_client::{DeviceIdentity, UnlockedVault};
use ll_crypto::{ClientPlatformClass, ObjectType};
use ll_versioning::CommitBody;
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use crate::formats::{decode_commit_body_input, decode_signed_commit_output, fixed, parse_parents};
use crate::js_error;

/// Unlocked VMK/subkeys held only in WebAssembly memory.
#[wasm_bindgen]
pub struct WasmVault {
    inner: UnlockedVault,
    created_envelope: Option<Vec<u8>>,
}

#[wasm_bindgen]
impl WasmVault {
    /// Creates a random VMK and calibrates/wraps it with the client password.
    ///
    /// # Errors
    ///
    /// Returns a safe JavaScript error for KDF, randomness, or AEAD failure.
    pub fn create(
        vault_id: &[u8],
        client_password: String,
        android: bool,
    ) -> Result<Self, JsValue> {
        let platform = if android {
            ClientPlatformClass::Android
        } else {
            ClientPlatformClass::Desktop
        };
        let (inner, created_envelope) =
            UnlockedVault::create(fixed(vault_id)?, Zeroizing::new(client_password), platform)
                .map_err(js_error)?;
        Ok(Self {
            inner,
            created_envelope: Some(created_envelope),
        })
    }

    /// Unlocks an existing VMK envelope.
    ///
    /// # Errors
    ///
    /// Wrong passwords and altered envelopes return the same safe error.
    pub fn unlock(
        vault_id: &[u8],
        client_password: String,
        envelope: &[u8],
    ) -> Result<Self, JsValue> {
        let inner =
            UnlockedVault::unlock(fixed(vault_id)?, Zeroizing::new(client_password), envelope)
                .map_err(js_error)?;
        Ok(Self {
            inner,
            created_envelope: None,
        })
    }

    /// Takes a newly created wrapped VMK envelope exactly once.
    ///
    /// # Errors
    ///
    /// Returns an error for a restored vault or a repeated call.
    #[wasm_bindgen(js_name = takeCreatedEnvelope)]
    pub fn take_created_envelope(&mut self) -> Result<Vec<u8>, JsValue> {
        self.created_envelope
            .take()
            .ok_or_else(|| JsValue::from_str("vault has no new key envelope"))
    }

    /// Encrypts one immutable object revision with a fresh DEK and nonces.
    ///
    /// # Errors
    ///
    /// Returns a type, limit, randomness, or AEAD failure.
    pub fn encrypt(
        &self,
        object_id: &[u8],
        revision: &str,
        object_type: u8,
        cleartext: &[u8],
    ) -> Result<Vec<u8>, JsValue> {
        self.inner
            .encrypt(
                fixed(object_id)?,
                revision
                    .parse()
                    .map_err(|_| JsValue::from_str("invalid revision"))?,
                ObjectType::try_from(object_type).map_err(js_error)?,
                cleartext,
            )
            .map_err(js_error)
    }

    /// Authenticates and decrypts one vault-bound object.
    ///
    /// # Errors
    ///
    /// Returns a generic safe error for wrong keys or altered data.
    pub fn decrypt(&self, encoded: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.inner
            .decrypt(encoded)
            .map(|(_, clear)| clear)
            .map_err(js_error)
    }

    /// Verifies, decrypts, and decodes a signed commit as stable JSON.
    ///
    /// # Errors
    ///
    /// Returns a safe error for an unknown signer, altered signature,
    /// malformed record, wrong vault, or altered ciphertext.
    #[wasm_bindgen(js_name = decodeSignedCommit)]
    pub fn decode_signed_commit(
        &self,
        encoded: &[u8],
        public_key: &[u8],
    ) -> Result<String, JsValue> {
        decode_signed_commit_output(&self.inner, encoded, &fixed(public_key)?)
    }

    /// Encrypts a deterministic commit body and signs its outer record.
    ///
    /// # Errors
    ///
    /// Returns JSON, format, key, signature, or AEAD failure.
    #[wasm_bindgen(js_name = createSignedCommit)]
    pub fn create_signed_commit(
        &self,
        device: &WasmDeviceIdentity,
        parents_flat: &[u8],
        device_sequence: &str,
        body_json: &str,
    ) -> Result<Vec<u8>, JsValue> {
        let body: CommitBody = decode_commit_body_input(body_json)?;
        self.inner
            .create_signed_commit(
                &device.inner,
                parse_parents(parents_flat)?,
                device_sequence
                    .parse()
                    .map_err(|_| JsValue::from_str("invalid device sequence"))?,
                &body,
            )
            .map_err(js_error)
    }

    pub(crate) const fn inner(&self) -> &UnlockedVault {
        &self.inner
    }
}

/// Client device ID and Ed25519 signing key held inside WebAssembly memory.
#[wasm_bindgen]
pub struct WasmDeviceIdentity {
    pub(crate) inner: DeviceIdentity,
}

#[wasm_bindgen]
impl WasmDeviceIdentity {
    /// Generates a new random device identity.
    ///
    /// # Errors
    ///
    /// Returns an OS randomness error.
    pub fn generate() -> Result<Self, JsValue> {
        DeviceIdentity::generate()
            .map(|inner| Self { inner })
            .map_err(js_error)
    }

    /// Restores an authenticated VMK-encrypted signing identity.
    ///
    /// # Errors
    ///
    /// Returns a generic error for altered or wrong-vault data.
    pub fn restore(vault: &WasmVault, encrypted: &[u8]) -> Result<Self, JsValue> {
        DeviceIdentity::from_encrypted(vault.inner(), encrypted)
            .map(|inner| Self { inner })
            .map_err(js_error)
    }

    /// Encrypts the signing identity for persistence.
    ///
    /// # Errors
    ///
    /// Returns a randomness, AEAD, or format failure.
    #[wasm_bindgen(js_name = encryptForStorage)]
    pub fn encrypt_for_storage(&self, vault: &WasmVault) -> Result<Vec<u8>, JsValue> {
        self.inner
            .encrypt_for_storage(vault.inner())
            .map_err(js_error)
    }

    /// Encrypts the user-visible device name before server registration.
    ///
    /// # Errors
    ///
    /// Returns a randomness, AEAD, or format failure.
    #[wasm_bindgen(js_name = encryptName)]
    pub fn encrypt_name(&self, vault: &WasmVault, name: &str) -> Result<Vec<u8>, JsValue> {
        vault
            .inner()
            .encrypt(
                self.inner.device_id(),
                1,
                ObjectType::Metadata,
                name.as_bytes(),
            )
            .map_err(js_error)
    }

    /// Stable random `UUIDv7` device identifier.
    #[must_use]
    pub fn id(&self) -> Vec<u8> {
        self.inner.device_id().to_vec()
    }

    /// Ed25519 verification key.
    #[must_use]
    #[wasm_bindgen(js_name = publicKey)]
    pub fn public_key(&self) -> Vec<u8> {
        self.inner.public_key().to_vec()
    }

    pub(crate) const fn inner(&self) -> &DeviceIdentity {
        &self.inner
    }
}
