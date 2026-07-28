use ll_client::ClientChannel;
use ll_protocol::{Request, Response};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use crate::{WasmDeviceIdentity, js_error};

/// Pinned, sequenced Noise transport state held inside WebAssembly memory.
#[wasm_bindgen]
pub struct WasmClientChannel {
    inner: ClientChannel,
    initial_message: Option<Vec<u8>>,
}

#[wasm_bindgen]
impl WasmClientChannel {
    /// Validates bootstrap identity and starts a fresh Noise handshake.
    ///
    /// # Errors
    ///
    /// Returns a safe JavaScript error for invalid bootstrap or Noise state.
    #[wasm_bindgen(constructor)]
    pub fn new(bootstrap: &[u8], pinned_fingerprint: &str) -> Result<Self, JsValue> {
        let (inner, initial_message) =
            ClientChannel::begin(bootstrap, pinned_fingerprint).map_err(js_error)?;
        Ok(Self {
            inner,
            initial_message: Some(initial_message),
        })
    }

    /// Takes the one-time initiator handshake body.
    ///
    /// # Errors
    ///
    /// Returns an error if it was already consumed.
    #[wasm_bindgen(js_name = takeHandshakeMessage)]
    pub fn take_handshake_message(&mut self) -> Result<Vec<u8>, JsValue> {
        self.initial_message
            .take()
            .ok_or_else(|| JsValue::from_str("handshake message already consumed"))
    }

    /// Completes the responder handshake and stores its authenticated challenge.
    ///
    /// # Errors
    ///
    /// Returns a safe JavaScript error for invalid ciphertext or state.
    #[wasm_bindgen(js_name = completeHandshake)]
    pub fn complete_handshake(&mut self, response: &[u8]) -> Result<(), JsValue> {
        self.inner.complete_handshake(response).map_err(js_error)
    }

    /// Builds the encrypted server-password/device authentication frame.
    ///
    /// # Errors
    ///
    /// Returns a KDF, state, signing, or transport failure.
    #[wasm_bindgen(js_name = authenticateNewDevice)]
    pub fn authenticate_new_device(&mut self, server_password: String) -> Result<Vec<u8>, JsValue> {
        self.inner
            .authenticate(Zeroizing::new(server_password), None)
            .map_err(js_error)
    }

    /// Builds encrypted server-password and existing-device proofs.
    ///
    /// # Errors
    ///
    /// Returns a KDF, state, signing, or transport failure.
    #[wasm_bindgen(js_name = authenticateExistingDevice)]
    pub fn authenticate_existing_device(
        &mut self,
        server_password: String,
        device: &WasmDeviceIdentity,
    ) -> Result<Vec<u8>, JsValue> {
        self.inner
            .authenticate(Zeroizing::new(server_password), Some(device.inner()))
            .map_err(js_error)
    }

    /// Builds device registration with a VMK-encrypted display name.
    ///
    /// # Errors
    ///
    /// Returns a state, signing, or transport failure.
    #[wasm_bindgen(js_name = registerDevice)]
    pub fn register_device(
        &mut self,
        device: &WasmDeviceIdentity,
        encrypted_name: Vec<u8>,
    ) -> Result<Vec<u8>, JsValue> {
        self.inner
            .register_device(device.inner(), encrypted_name)
            .map_err(js_error)
    }

    /// Builds an encrypted request to initialize the wrapped VMK.
    ///
    /// # Errors
    ///
    /// Returns a protocol, state, or transport failure.
    #[wasm_bindgen(js_name = putVaultKeyEnvelope)]
    pub fn put_vault_key_envelope(&mut self, envelope: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        self.request(Request::PutVaultKeyEnvelope { envelope })
    }

    /// Builds an encrypted request to fetch the wrapped VMK.
    ///
    /// # Errors
    ///
    /// Returns a protocol, state, or transport failure.
    #[wasm_bindgen(js_name = getVaultKeyEnvelope)]
    pub fn get_vault_key_envelope(&mut self) -> Result<Vec<u8>, JsValue> {
        self.request(Request::GetVaultKeyEnvelope)
    }

    /// Builds a device-list request.
    ///
    /// # Errors
    ///
    /// Returns a protocol, state, or transport failure.
    #[wasm_bindgen(js_name = listDevices)]
    pub fn list_devices(&mut self) -> Result<Vec<u8>, JsValue> {
        self.request(Request::ListDevices)
    }

    /// Builds a device revocation request.
    ///
    /// # Errors
    ///
    /// Returns a length, protocol, state, or transport failure.
    #[wasm_bindgen(js_name = revokeDevice)]
    pub fn revoke_device(&mut self, device_id: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.request(Request::RevokeDevice {
            device_id: fixed(device_id)?,
        })
    }

    /// Builds a resumable upload allocation request.
    ///
    /// # Errors
    ///
    /// Returns a size, hash, protocol, state, or transport failure.
    #[wasm_bindgen(js_name = beginUpload)]
    pub fn begin_upload(
        &mut self,
        expected_size: &str,
        expected_hash: &[u8],
    ) -> Result<Vec<u8>, JsValue> {
        self.request(Request::BeginUpload {
            expected_size: parse_u64(expected_size)?,
            expected_hash: fixed(expected_hash)?,
        })
    }

    /// Builds one exact-offset upload chunk request.
    ///
    /// # Errors
    ///
    /// Returns an ID, offset, protocol, state, or transport failure.
    #[wasm_bindgen(js_name = uploadChunk)]
    pub fn upload_chunk(
        &mut self,
        upload_id: &[u8],
        offset: &str,
        chunk: Vec<u8>,
    ) -> Result<Vec<u8>, JsValue> {
        self.request(Request::UploadChunk {
            upload_id: fixed(upload_id)?,
            offset: parse_u64(offset)?,
            chunk,
        })
    }

    /// Builds an upload commit request.
    ///
    /// # Errors
    ///
    /// Returns an ID, protocol, state, or transport failure.
    #[wasm_bindgen(js_name = commitUpload)]
    pub fn commit_upload(&mut self, upload_id: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.request(Request::CommitUpload {
            upload_id: fixed(upload_id)?,
        })
    }

    /// Builds a bounded ciphertext download request.
    ///
    /// # Errors
    ///
    /// Returns an ID, offset, protocol, state, or transport failure.
    #[wasm_bindgen(js_name = getBlob)]
    pub fn get_blob(
        &mut self,
        blob_id: &[u8],
        offset: &str,
        maximum_bytes: u32,
    ) -> Result<Vec<u8>, JsValue> {
        self.request(Request::GetBlob {
            blob_id: fixed(blob_id)?,
            offset: parse_u64(offset)?,
            maximum_bytes,
        })
    }

    /// Builds an immutable signed commit insertion request.
    ///
    /// # Errors
    ///
    /// Returns a protocol, state, or transport failure.
    #[wasm_bindgen(js_name = putCommit)]
    pub fn put_commit(&mut self, signed_commit: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        self.request(Request::PutCommit { signed_commit })
    }

    /// Builds an exact commit fetch.
    ///
    /// # Errors
    ///
    /// Returns an ID, protocol, state, or transport failure.
    #[wasm_bindgen(js_name = getCommit)]
    pub fn get_commit(&mut self, commit_id: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.request(Request::GetCommit {
            commit_id: fixed(commit_id)?,
        })
    }

    /// Builds a current-head request.
    ///
    /// # Errors
    ///
    /// Returns a protocol, state, or transport failure.
    #[wasm_bindgen(js_name = getHeads)]
    pub fn get_heads(&mut self) -> Result<Vec<u8>, JsValue> {
        self.request(Request::GetHeads)
    }

    /// Builds a bounded parents-before-children change request.
    ///
    /// # Errors
    ///
    /// Returns an ID, limit, protocol, state, or transport failure.
    #[wasm_bindgen(js_name = getChanges)]
    pub fn get_changes(
        &mut self,
        known_ids_flat: &[u8],
        maximum_commits: u16,
    ) -> Result<Vec<u8>, JsValue> {
        if !known_ids_flat.len().is_multiple_of(32) {
            return Err(JsValue::from_str("known commit IDs have invalid length"));
        }
        let known_commit_ids = known_ids_flat
            .chunks_exact(32)
            .map(fixed)
            .collect::<Result<Vec<_>, _>>()?;
        self.request(Request::GetChanges {
            known_commit_ids,
            maximum_commits,
        })
    }

    /// Builds an authenticated liveness request.
    ///
    /// # Errors
    ///
    /// Returns a protocol, state, or transport failure.
    pub fn ping(&mut self) -> Result<Vec<u8>, JsValue> {
        self.request(Request::Ping)
    }

    /// Authenticates and decodes one HTTP response frame.
    ///
    /// # Errors
    ///
    /// Returns a frame, Noise, sequence, or protocol failure.
    pub fn response(&mut self, frame: &[u8]) -> Result<WasmResponse, JsValue> {
        self.inner
            .response(frame)
            .map(|inner| WasmResponse { inner })
            .map_err(js_error)
    }

    fn request(&mut self, request: Request) -> Result<Vec<u8>, JsValue> {
        self.inner.request(request).map_err(js_error)
    }
}

/// Decoded authenticated protocol response.
#[wasm_bindgen]
pub struct WasmResponse {
    inner: Response,
}

#[wasm_bindgen]
impl WasmResponse {
    /// Stable response kind used by the TypeScript adapter.
    #[must_use]
    pub fn kind(&self) -> u16 {
        match self.inner {
            Response::Authenticated { .. } => 1,
            Response::DeviceRegistered => 2,
            Response::Devices(_) => 3,
            Response::DeviceRevoked => 4,
            Response::UploadReady { .. } => 5,
            Response::ChunkAccepted { .. } => 6,
            Response::UploadCommitted { .. } => 7,
            Response::BlobChunk { .. } => 8,
            Response::Pong => 9,
            Response::CommitStored { .. } => 10,
            Response::CommitRecord { .. } => 11,
            Response::Heads(_) => 12,
            Response::Changes { .. } => 13,
            Response::VaultKeyEnvelopeStored => 14,
            Response::VaultKeyEnvelope { .. } => 15,
            Response::Error(_) => 255,
        }
    }

    /// Boolean payload for authentication, blob completion, or change paging.
    #[must_use]
    pub fn flag(&self) -> bool {
        match &self.inner {
            Response::Authenticated {
                device_authenticated,
                ..
            } => *device_authenticated,
            Response::BlobChunk { complete, .. } => *complete,
            Response::Changes { has_more, .. } => *has_more,
            _ => false,
        }
    }

    /// Primary fixed identifier payload, if present.
    #[must_use]
    pub fn id(&self) -> Vec<u8> {
        match &self.inner {
            Response::Authenticated { vault_id, .. } => vault_id.to_vec(),
            Response::UploadReady { upload_id, .. } => upload_id.to_vec(),
            Response::UploadCommitted { blob_id } => blob_id.to_vec(),
            Response::CommitStored { commit_id, .. } => commit_id.to_vec(),
            _ => Vec::new(),
        }
    }

    /// Primary opaque byte payload, if present.
    #[must_use]
    pub fn bytes(&self) -> Vec<u8> {
        match &self.inner {
            Response::BlobChunk { chunk, .. } => chunk.clone(),
            Response::CommitRecord { signed_commit } => signed_commit.clone(),
            Response::VaultKeyEnvelope { envelope } => envelope.clone(),
            _ => Vec::new(),
        }
    }

    /// Offset or total byte count as a decimal string.
    #[must_use]
    pub fn offset(&self) -> String {
        match self.inner {
            Response::UploadReady { offset, .. }
            | Response::ChunkAccepted { offset }
            | Response::BlobChunk { offset, .. } => offset.to_string(),
            _ => String::new(),
        }
    }

    /// Blob total size as a decimal string.
    #[must_use]
    pub fn total(&self) -> String {
        match self.inner {
            Response::BlobChunk { total_size, .. } => total_size.to_string(),
            _ => String::new(),
        }
    }

    /// Sorted fixed-size head IDs as one flat byte array.
    #[must_use]
    #[wasm_bindgen(js_name = headsFlat)]
    pub fn heads_flat(&self) -> Vec<u8> {
        let (Response::Heads(heads) | Response::CommitStored { heads, .. }) = &self.inner else {
            return Vec::new();
        };
        heads.iter().flatten().copied().collect()
    }

    /// Number of returned change records or devices.
    #[must_use]
    pub fn count(&self) -> usize {
        match &self.inner {
            Response::Changes { commits, .. } => commits.len(),
            Response::Devices(devices) => devices.len(),
            _ => 0,
        }
    }

    /// Returns one signed change record.
    #[must_use]
    pub fn commit(&self, index: usize) -> Vec<u8> {
        match &self.inner {
            Response::Changes { commits, .. } => commits.get(index).cloned().unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    /// Returns one device record as stable JSON containing only opaque values.
    #[must_use]
    pub fn device(&self, index: usize) -> String {
        let Response::Devices(devices) = &self.inner else {
            return String::new();
        };
        let Some(device) = devices.get(index) else {
            return String::new();
        };
        serde_json::json!({
            "device_id_hex": hex::encode(device.device_id),
            "public_key_hex": hex::encode(device.public_key),
            "encrypted_name_hex": hex::encode(&device.encrypted_name),
            "revoked": device.revoked,
        })
        .to_string()
    }

    /// Stable encrypted error code, or zero for a non-error response.
    #[must_use]
    #[wasm_bindgen(js_name = errorCode)]
    pub fn error_code(&self) -> u16 {
        match self.inner {
            Response::Error(code) => code as u16,
            _ => 0,
        }
    }
}

fn parse_u64(value: &str) -> Result<u64, JsValue> {
    value
        .parse()
        .map_err(|_| JsValue::from_str("invalid unsigned integer"))
}

fn fixed<const N: usize>(value: &[u8]) -> Result<[u8; N], JsValue> {
    value
        .try_into()
        .map_err(|_| JsValue::from_str("fixed byte field has invalid length"))
}
