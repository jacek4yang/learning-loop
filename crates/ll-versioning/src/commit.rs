use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use ll_crypto::{ObjectType, decode_object_envelope};
use minicbor::{Decoder, Encoder};
use subtle::ConstantTimeEq;

use crate::VersioningError;

const COMMIT_ID_LABEL: &[u8] = b"learning-loop/commit-id/v1";
const COMMIT_SIGNATURE_LABEL: &[u8] = b"learning-loop/commit-signature/v1";

/// Maximum encrypted commit-body envelope size.
pub const MAX_COMMIT_BODY_BYTES: usize = 256 * 1024;
/// Maximum parent count on a merge commit.
pub const MAX_COMMIT_PARENTS: usize = 16;
/// Maximum complete signed record size.
pub const MAX_SIGNED_COMMIT_BYTES: usize = ll_protocol::MAX_SIGNED_COMMIT_BYTES;

/// Outer server-visible immutable commit fields.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnsignedCommit {
    /// Vault identifier.
    pub vault_id: [u8; 16],
    /// Lexicographically sorted unique parents.
    pub parents: Vec<[u8; 32]>,
    /// Signing device.
    pub device_id: [u8; 16],
    /// Strict per-device sequence beginning at one.
    pub device_sequence: u64,
    /// Client-encrypted commit body object envelope.
    pub encrypted_body: Vec<u8>,
}

/// Transmitted signed commit record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignedCommit {
    /// Validated unsigned fields.
    pub unsigned: UnsignedCommit,
    /// Domain-separated BLAKE3 identifier.
    pub commit_id: [u8; 32],
    /// Ed25519 signature over the identifier context.
    pub signature: [u8; 64],
}

impl SignedCommit {
    /// Validates, hashes, and signs one commit.
    ///
    /// # Errors
    ///
    /// Returns a [`VersioningError`] for invalid parents, sequence, encrypted
    /// body, limits, or deterministic encoding.
    pub fn create(
        unsigned: UnsignedCommit,
        signing_key: &SigningKey,
    ) -> Result<Self, VersioningError> {
        validate_unsigned(&unsigned)?;
        let encoded = encode_unsigned(&unsigned)?;
        let commit_id = commit_id(&encoded);
        let signature = signing_key
            .sign(&commit_signature_context(&commit_id))
            .to_bytes();
        Ok(Self {
            unsigned,
            commit_id,
            signature,
        })
    }
}

/// Domain-separated bytes signed by a device.
#[must_use]
pub fn commit_signature_context(commit_id: &[u8; 32]) -> Vec<u8> {
    let mut context = Vec::with_capacity(COMMIT_SIGNATURE_LABEL.len() + commit_id.len());
    context.extend_from_slice(COMMIT_SIGNATURE_LABEL);
    context.extend_from_slice(commit_id);
    context
}

/// Verifies the device signature on an already structurally validated commit.
///
/// # Errors
///
/// Returns [`VersioningError::InvalidSignature`] for a malformed key or
/// invalid signature.
pub fn verify_signed_commit(
    commit: &SignedCommit,
    public_key: &[u8; 32],
) -> Result<(), VersioningError> {
    let key =
        VerifyingKey::from_bytes(public_key).map_err(|_| VersioningError::InvalidSignature)?;
    key.verify(
        &commit_signature_context(&commit.commit_id),
        &Signature::from_bytes(&commit.signature),
    )
    .map_err(|_| VersioningError::InvalidSignature)
}

/// Encodes a signed commit in exact deterministic CBOR.
///
/// # Errors
///
/// Returns a [`VersioningError`] for invalid fields, limits, or encoding.
pub fn encode_signed_commit(commit: &SignedCommit) -> Result<Vec<u8>, VersioningError> {
    validate_unsigned(&commit.unsigned)?;
    let unsigned = encode_unsigned(&commit.unsigned)?;
    if !bool::from(commit_id(&unsigned).ct_eq(&commit.commit_id)) {
        return Err(VersioningError::InvalidCommitId);
    }
    let mut output = Vec::new();
    Encoder::new(&mut output)
        .map(3)?
        .u8(0)?
        .bytes(&unsigned)?
        .u8(1)?
        .bytes(&commit.commit_id)?
        .u8(2)?
        .bytes(&commit.signature)?;
    if output.len() > MAX_SIGNED_COMMIT_BYTES {
        return Err(VersioningError::LimitExceeded);
    }
    Ok(output)
}

/// Decodes, bounds, recomputes, and exact-reencodes a signed commit.
///
/// # Errors
///
/// Returns a [`VersioningError`] for malformed, oversized, non-deterministic,
/// unsupported, or hash-inconsistent data.
pub fn decode_signed_commit(encoded: &[u8]) -> Result<SignedCommit, VersioningError> {
    if encoded.len() > MAX_SIGNED_COMMIT_BYTES {
        return Err(VersioningError::LimitExceeded);
    }
    let mut decoder = Decoder::new(encoded);
    expect_map(&mut decoder, 3)?;
    expect_key(&mut decoder, 0)?;
    let unsigned_bytes = decoder.bytes()?;
    let unsigned = decode_unsigned(unsigned_bytes)?;
    expect_key(&mut decoder, 1)?;
    let supplied_id: [u8; 32] = fixed_bytes(decoder.bytes()?)?;
    let actual_id = commit_id(unsigned_bytes);
    if !bool::from(actual_id.ct_eq(&supplied_id)) {
        return Err(VersioningError::InvalidCommitId);
    }
    expect_key(&mut decoder, 2)?;
    let signature = fixed_bytes(decoder.bytes()?)?;
    let commit = SignedCommit {
        unsigned,
        commit_id: actual_id,
        signature,
    };
    if decoder.position() != encoded.len()
        || !bool::from(encode_signed_commit(&commit)?.ct_eq(encoded))
    {
        return Err(VersioningError::InvalidFormat);
    }
    Ok(commit)
}

fn validate_unsigned(unsigned: &UnsignedCommit) -> Result<(), VersioningError> {
    if unsigned.device_sequence == 0
        || unsigned.parents.len() > MAX_COMMIT_PARENTS
        || unsigned.encrypted_body.len() > MAX_COMMIT_BODY_BYTES
    {
        return Err(VersioningError::LimitExceeded);
    }
    if !unsigned.parents.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(VersioningError::InvalidFormat);
    }
    let body = decode_object_envelope(&unsigned.encrypted_body)
        .map_err(|_| VersioningError::InvalidEncryptedBody)?;
    if body.vault_id != unsigned.vault_id || body.object_type != ObjectType::Commit {
        return Err(VersioningError::InvalidEncryptedBody);
    }
    Ok(())
}

fn encode_unsigned(unsigned: &UnsignedCommit) -> Result<Vec<u8>, VersioningError> {
    validate_unsigned(unsigned)?;
    let body_hash = blake3::hash(&unsigned.encrypted_body);
    let body_size =
        u64::try_from(unsigned.encrypted_body.len()).map_err(|_| VersioningError::LimitExceeded)?;
    let mut output = Vec::new();
    let mut encoder = Encoder::new(&mut output);
    encoder
        .map(8)?
        .u8(0)?
        .u16(ll_protocol::PROTOCOL_VERSION)?
        .u8(1)?
        .bytes(&unsigned.vault_id)?
        .u8(2)?
        .array(
            u64::try_from(unsigned.parents.len()).map_err(|_| VersioningError::LimitExceeded)?,
        )?;
    for parent in &unsigned.parents {
        encoder.bytes(parent)?;
    }
    encoder
        .u8(3)?
        .bytes(&unsigned.device_id)?
        .u8(4)?
        .u64(unsigned.device_sequence)?
        .u8(5)?
        .u64(body_size)?
        .u8(6)?
        .bytes(body_hash.as_bytes())?
        .u8(7)?
        .bytes(&unsigned.encrypted_body)?;
    Ok(output)
}

fn decode_unsigned(encoded: &[u8]) -> Result<UnsignedCommit, VersioningError> {
    let mut decoder = Decoder::new(encoded);
    expect_map(&mut decoder, 8)?;
    expect_key(&mut decoder, 0)?;
    if decoder.u16()? != ll_protocol::PROTOCOL_VERSION {
        return Err(VersioningError::InvalidFormat);
    }
    expect_key(&mut decoder, 1)?;
    let vault_id = fixed_bytes(decoder.bytes()?)?;
    expect_key(&mut decoder, 2)?;
    let parent_count = definite_array(&mut decoder)?;
    if parent_count > MAX_COMMIT_PARENTS {
        return Err(VersioningError::LimitExceeded);
    }
    let mut parents = Vec::with_capacity(parent_count);
    for _ in 0..parent_count {
        parents.push(fixed_bytes(decoder.bytes()?)?);
    }
    expect_key(&mut decoder, 3)?;
    let device_id = fixed_bytes(decoder.bytes()?)?;
    expect_key(&mut decoder, 4)?;
    let device_sequence = decoder.u64()?;
    expect_key(&mut decoder, 5)?;
    let declared_size = decoder.u64()?;
    expect_key(&mut decoder, 6)?;
    let declared_hash: [u8; 32] = fixed_bytes(decoder.bytes()?)?;
    expect_key(&mut decoder, 7)?;
    let encrypted_body = decoder.bytes()?.to_vec();
    if encrypted_body.len() > MAX_COMMIT_BODY_BYTES
        || u64::try_from(encrypted_body.len()).map_err(|_| VersioningError::LimitExceeded)?
            != declared_size
        || !bool::from(
            blake3::hash(&encrypted_body)
                .as_bytes()
                .ct_eq(&declared_hash),
        )
    {
        return Err(VersioningError::InvalidFormat);
    }
    let unsigned = UnsignedCommit {
        vault_id,
        parents,
        device_id,
        device_sequence,
        encrypted_body,
    };
    validate_unsigned(&unsigned)?;
    if decoder.position() != encoded.len()
        || !bool::from(encode_unsigned(&unsigned)?.ct_eq(encoded))
    {
        return Err(VersioningError::InvalidFormat);
    }
    Ok(unsigned)
}

fn commit_id(unsigned: &[u8]) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(COMMIT_ID_LABEL);
    hasher.update(unsigned);
    *hasher.finalize().as_bytes()
}

fn expect_map(decoder: &mut Decoder<'_>, expected: u64) -> Result<(), VersioningError> {
    if decoder.map()? == Some(expected) {
        Ok(())
    } else {
        Err(VersioningError::InvalidFormat)
    }
}

fn expect_key(decoder: &mut Decoder<'_>, expected: u8) -> Result<(), VersioningError> {
    if decoder.u8()? == expected {
        Ok(())
    } else {
        Err(VersioningError::InvalidFormat)
    }
}

fn definite_array(decoder: &mut Decoder<'_>) -> Result<usize, VersioningError> {
    let length = decoder.array()?.ok_or(VersioningError::InvalidFormat)?;
    usize::try_from(length).map_err(|_| VersioningError::LimitExceeded)
}

fn fixed_bytes<const N: usize>(bytes: &[u8]) -> Result<[u8; N], VersioningError> {
    bytes.try_into().map_err(|_| VersioningError::InvalidFormat)
}

#[cfg(test)]
mod tests {
    use ll_crypto::{ObjectType, VaultMasterKey, encrypt_object};
    use ll_testkit::{random_device_signing_key, test_uuid};

    use super::{
        SignedCommit, UnsignedCommit, decode_signed_commit, encode_signed_commit,
        verify_signed_commit,
    };

    fn vector_section() -> serde_json::Value {
        serde_json::from_str::<serde_json::Value>(include_str!(
            "../../../protocol/test-vectors/encrypted-versioning-v1.json"
        ))
        .unwrap()["signed_commit"]
            .clone()
    }

    fn vector_string<'a>(value: &'a serde_json::Value, key: &str) -> &'a str {
        value[key].as_str().unwrap()
    }

    fn vector_array<const N: usize>(value: &serde_json::Value, key: &str) -> [u8; N] {
        hex::decode(vector_string(value, key))
            .unwrap()
            .try_into()
            .unwrap()
    }

    #[test]
    fn signed_commit_round_trips_and_tampering_fails() {
        let vault_id = test_uuid();
        let body = encrypt_object(
            &VaultMasterKey::generate()
                .unwrap()
                .derive_subkeys(&vault_id)
                .unwrap(),
            vault_id,
            test_uuid(),
            1,
            ObjectType::Commit,
            b"encrypted commit body plaintext fixture",
        )
        .unwrap();
        let signing = random_device_signing_key().unwrap();
        let commit = SignedCommit::create(
            UnsignedCommit {
                vault_id,
                parents: Vec::new(),
                device_id: test_uuid(),
                device_sequence: 1,
                encrypted_body: body,
            },
            &signing,
        )
        .unwrap();
        let encoded = encode_signed_commit(&commit).unwrap();
        let decoded = decode_signed_commit(&encoded).unwrap();
        verify_signed_commit(&decoded, &signing.verifying_key().to_bytes()).unwrap();
        let mut altered = encoded;
        *altered.last_mut().unwrap() ^= 1;
        let altered = decode_signed_commit(&altered).unwrap();
        assert!(verify_signed_commit(&altered, &signing.verifying_key().to_bytes()).is_err());
    }

    #[test]
    fn signed_commit_matches_shared_known_answer_vector() {
        let vector = vector_section();
        let signing =
            ed25519_dalek::SigningKey::from_bytes(&vector_array(&vector, "signing_seed_hex"));
        let commit = SignedCommit::create(
            UnsignedCommit {
                vault_id: vector_array(&vector, "vault_id_hex"),
                parents: vec![vector_array(&vector, "parent_id_hex")],
                device_id: vector_array(&vector, "device_id_hex"),
                device_sequence: vector["device_sequence"].as_u64().unwrap(),
                encrypted_body: hex::decode(vector_string(&vector, "encrypted_body_hex")).unwrap(),
            },
            &signing,
        )
        .unwrap();
        let encoded = encode_signed_commit(&commit).unwrap();
        assert_eq!(
            hex::encode(signing.verifying_key().to_bytes()),
            vector_string(&vector, "public_key_hex")
        );
        assert_eq!(
            hex::encode(commit.commit_id),
            vector_string(&vector, "commit_id_hex")
        );
        assert_eq!(hex::encode(&encoded), vector_string(&vector, "encoded_hex"));
        let decoded = decode_signed_commit(&encoded).unwrap();
        verify_signed_commit(&decoded, &signing.verifying_key().to_bytes()).unwrap();
    }
}
