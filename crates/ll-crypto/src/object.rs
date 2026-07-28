use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::array::Array;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use minicbor::{Decoder, Encoder};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::{CryptoError, VaultSubkeys, random_array};

/// Fixed object cipher-suite name bound into authenticated data.
pub const CIPHER_SUITE: &str = "XChaCha20-Poly1305/HKDF-SHA-256/v1";
const MAX_OBJECT_CIPHERTEXT_BYTES: usize = 512 * 1024 * 1024 + 16;
const DEK_BYTES: usize = 32;
const NONCE_BYTES: usize = 24;
const TAG_BYTES: usize = 16;

#[derive(Clone, Copy)]
struct ObjectIdentity {
    vault_id: [u8; 16],
    object_id: [u8; 16],
    revision: u64,
    object_type: ObjectType,
}

#[derive(Clone, Copy)]
struct EncryptionMaterial<'a> {
    dek: &'a [u8; DEK_BYTES],
    payload_nonce: [u8; NONCE_BYTES],
    wrapped_dek_nonce: [u8; NONCE_BYTES],
}

/// Domain and semantic type of an encrypted object.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum ObjectType {
    /// Canonical text or other ordinary file content.
    Content = 1,
    /// Logical portable path bytes.
    Path = 2,
    /// Properties and other client-only metadata.
    Metadata = 3,
    /// Encrypted commit body.
    Commit = 4,
    /// Binary attachment content.
    Attachment = 5,
    /// Recovery material.
    Recovery = 6,
}

impl TryFrom<u8> for ObjectType {
    type Error = CryptoError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Content),
            2 => Ok(Self::Path),
            3 => Ok(Self::Metadata),
            4 => Ok(Self::Commit),
            5 => Ok(Self::Attachment),
            6 => Ok(Self::Recovery),
            _ => Err(CryptoError::InvalidEnvelope),
        }
    }
}

/// Parsed deterministic encrypted object envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObjectEnvelope {
    /// Vault identifier.
    pub vault_id: [u8; 16],
    /// Stable object identifier.
    pub object_id: [u8; 16],
    /// Monotonic object revision.
    pub revision: u64,
    /// Encryption domain and semantic type.
    pub object_type: ObjectType,
    /// Fresh payload nonce.
    pub payload_nonce: [u8; NONCE_BYTES],
    /// Fresh DEK-wrapping nonce.
    pub wrapped_dek_nonce: [u8; NONCE_BYTES],
    /// AEAD-wrapped 32-byte DEK.
    pub wrapped_dek: Vec<u8>,
    /// AEAD ciphertext and tag.
    pub ciphertext: Vec<u8>,
}

/// Encrypts a new immutable object revision with a random DEK and two nonces.
///
/// # Errors
///
/// Returns a [`CryptoError`] for randomness, limits, derivation, encryption,
/// or deterministic encoding failures.
pub fn encrypt_object(
    subkeys: &VaultSubkeys,
    vault_id: [u8; 16],
    object_id: [u8; 16],
    revision: u64,
    object_type: ObjectType,
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if revision == 0 || plaintext.len() > MAX_OBJECT_CIPHERTEXT_BYTES - TAG_BYTES {
        return Err(CryptoError::EnvelopeLimit);
    }
    let dek = Zeroizing::new(random_array::<DEK_BYTES>()?);
    let payload_nonce = random_array::<NONCE_BYTES>()?;
    let wrapped_dek_nonce = random_array::<NONCE_BYTES>()?;
    encrypt_object_with_material(
        subkeys,
        ObjectIdentity {
            vault_id,
            object_id,
            revision,
            object_type,
        },
        plaintext,
        EncryptionMaterial {
            dek: &dek,
            payload_nonce,
            wrapped_dek_nonce,
        },
    )
}

/// Decrypts and authenticates one exact deterministic object envelope.
///
/// # Errors
///
/// Returns a [`CryptoError`] for format, limits, wrong key, altered metadata,
/// or altered ciphertext.
pub fn decrypt_object(
    subkeys: &VaultSubkeys,
    encoded: &[u8],
) -> Result<(ObjectEnvelope, Vec<u8>), CryptoError> {
    let envelope = decode_object_envelope(encoded)?;
    let payload_aad = object_aad(&envelope, b"payload")?;
    let wrapping_aad = object_aad(&envelope, b"wrapped-dek")?;
    let wrapping_key = Array(*subkeys.key_for(envelope.object_type));
    let wrapping_cipher = XChaCha20Poly1305::new(&wrapping_key);
    let wrapped_nonce = Array(envelope.wrapped_dek_nonce);
    let dek = Zeroizing::new(
        wrapping_cipher
            .decrypt(
                &wrapped_nonce,
                Payload {
                    msg: &envelope.wrapped_dek,
                    aad: &wrapping_aad,
                },
            )
            .map_err(|_| CryptoError::AuthenticatedEncryption)?,
    );
    let dek_bytes: [u8; DEK_BYTES] = dek
        .as_slice()
        .try_into()
        .map_err(|_| CryptoError::InvalidEnvelope)?;
    let cipher = XChaCha20Poly1305::new(&Array(dek_bytes));
    let plaintext = cipher
        .decrypt(
            &Array(envelope.payload_nonce),
            Payload {
                msg: &envelope.ciphertext,
                aad: &payload_aad,
            },
        )
        .map_err(|_| CryptoError::AuthenticatedEncryption)?;
    Ok((envelope, plaintext))
}

/// Decodes, bounds, and exact-reencodes an object envelope.
///
/// # Errors
///
/// Returns a [`CryptoError`] for malformed, unsupported, oversized, trailing,
/// or non-deterministic input.
pub fn decode_object_envelope(encoded: &[u8]) -> Result<ObjectEnvelope, CryptoError> {
    if encoded.len() > MAX_OBJECT_CIPHERTEXT_BYTES + 512 {
        return Err(CryptoError::EnvelopeLimit);
    }
    let mut decoder = Decoder::new(encoded);
    if decoder.map()? != Some(9) {
        return Err(CryptoError::InvalidEnvelope);
    }
    expect_key(&mut decoder, 0)?;
    if decoder.u16()? != ll_protocol::PROTOCOL_VERSION {
        return Err(CryptoError::InvalidEnvelope);
    }
    expect_key(&mut decoder, 1)?;
    let vault_id = fixed_bytes(decoder.bytes()?)?;
    expect_key(&mut decoder, 2)?;
    let object_id = fixed_bytes(decoder.bytes()?)?;
    expect_key(&mut decoder, 3)?;
    let revision = decoder.u64()?;
    if revision == 0 {
        return Err(CryptoError::InvalidEnvelope);
    }
    expect_key(&mut decoder, 4)?;
    let object_type = ObjectType::try_from(decoder.u8()?)?;
    expect_key(&mut decoder, 5)?;
    let payload_nonce = fixed_bytes(decoder.bytes()?)?;
    expect_key(&mut decoder, 6)?;
    let wrapped_dek_nonce = fixed_bytes(decoder.bytes()?)?;
    expect_key(&mut decoder, 7)?;
    let wrapped_dek = decoder.bytes()?.to_vec();
    if wrapped_dek.len() != DEK_BYTES + TAG_BYTES {
        return Err(CryptoError::InvalidEnvelope);
    }
    expect_key(&mut decoder, 8)?;
    let ciphertext = decoder.bytes()?;
    if !(TAG_BYTES..=MAX_OBJECT_CIPHERTEXT_BYTES).contains(&ciphertext.len()) {
        return Err(CryptoError::EnvelopeLimit);
    }
    let envelope = ObjectEnvelope {
        vault_id,
        object_id,
        revision,
        object_type,
        payload_nonce,
        wrapped_dek_nonce,
        wrapped_dek,
        ciphertext: ciphertext.to_vec(),
    };
    if decoder.position() != encoded.len()
        || !bool::from(encode_object_envelope(&envelope)?.ct_eq(encoded))
    {
        return Err(CryptoError::InvalidEnvelope);
    }
    Ok(envelope)
}

/// Computes the opaque object address over the exact encoded ciphertext.
#[must_use]
pub fn ciphertext_blob_id(encoded: &[u8]) -> [u8; 32] {
    *blake3::hash(encoded).as_bytes()
}

fn encrypt_object_with_material(
    subkeys: &VaultSubkeys,
    identity: ObjectIdentity,
    plaintext: &[u8],
    material: EncryptionMaterial<'_>,
) -> Result<Vec<u8>, CryptoError> {
    let mut envelope = ObjectEnvelope {
        vault_id: identity.vault_id,
        object_id: identity.object_id,
        revision: identity.revision,
        object_type: identity.object_type,
        payload_nonce: material.payload_nonce,
        wrapped_dek_nonce: material.wrapped_dek_nonce,
        wrapped_dek: Vec::new(),
        ciphertext: Vec::new(),
    };
    let payload_aad = object_aad(&envelope, b"payload")?;
    let wrapping_aad = object_aad(&envelope, b"wrapped-dek")?;
    envelope.ciphertext = XChaCha20Poly1305::new(&Array(*material.dek))
        .encrypt(
            &Array(material.payload_nonce),
            Payload {
                msg: plaintext,
                aad: &payload_aad,
            },
        )
        .map_err(|_| CryptoError::AuthenticatedEncryption)?;
    envelope.wrapped_dek = XChaCha20Poly1305::new(&Array(*subkeys.key_for(identity.object_type)))
        .encrypt(
            &Array(material.wrapped_dek_nonce),
            Payload {
                msg: material.dek,
                aad: &wrapping_aad,
            },
        )
        .map_err(|_| CryptoError::AuthenticatedEncryption)?;
    encode_object_envelope(&envelope)
}

fn encode_object_envelope(envelope: &ObjectEnvelope) -> Result<Vec<u8>, CryptoError> {
    let mut output = Vec::new();
    Encoder::new(&mut output)
        .map(9)?
        .u8(0)?
        .u16(ll_protocol::PROTOCOL_VERSION)?
        .u8(1)?
        .bytes(&envelope.vault_id)?
        .u8(2)?
        .bytes(&envelope.object_id)?
        .u8(3)?
        .u64(envelope.revision)?
        .u8(4)?
        .u8(envelope.object_type as u8)?
        .u8(5)?
        .bytes(&envelope.payload_nonce)?
        .u8(6)?
        .bytes(&envelope.wrapped_dek_nonce)?
        .u8(7)?
        .bytes(&envelope.wrapped_dek)?
        .u8(8)?
        .bytes(&envelope.ciphertext)?;
    Ok(output)
}

fn object_aad(envelope: &ObjectEnvelope, purpose: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut output = Vec::new();
    Encoder::new(&mut output)
        .array(7)?
        .u16(ll_protocol::PROTOCOL_VERSION)?
        .bytes(&envelope.vault_id)?
        .bytes(&envelope.object_id)?
        .u64(envelope.revision)?
        .u8(envelope.object_type as u8)?
        .str(CIPHER_SUITE)?
        .bytes(purpose)?;
    Ok(output)
}

fn expect_key(decoder: &mut Decoder<'_>, key: u8) -> Result<(), CryptoError> {
    if decoder.u8()? == key {
        Ok(())
    } else {
        Err(CryptoError::InvalidEnvelope)
    }
}

fn fixed_bytes<const N: usize>(bytes: &[u8]) -> Result<[u8; N], CryptoError> {
    bytes.try_into().map_err(|_| CryptoError::InvalidEnvelope)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{
        ObjectType, ciphertext_blob_id, decode_object_envelope, decrypt_object, encrypt_object,
    };
    use crate::{VaultMasterKey, random_array};

    fn vector_section(name: &str) -> serde_json::Value {
        serde_json::from_str::<serde_json::Value>(include_str!(
            "../../../protocol/test-vectors/encrypted-versioning-v1.json"
        ))
        .unwrap()[name]
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
    fn object_round_trip_binds_all_metadata_and_has_fresh_nonces() {
        let master = VaultMasterKey::from_bytes(random_array::<32>().unwrap());
        let vault_id = random_array::<16>().unwrap();
        let object_id = random_array::<16>().unwrap();
        let subkeys = master.derive_subkeys(&vault_id).unwrap();
        let mut nonce_pairs = HashSet::new();
        let mut previous_blob = None;
        for _ in 0..64 {
            let encoded = encrypt_object(
                &subkeys,
                vault_id,
                object_id,
                1,
                ObjectType::Content,
                b"canonical plaintext",
            )
            .unwrap();
            let envelope = decode_object_envelope(&encoded).unwrap();
            assert!(nonce_pairs.insert((envelope.payload_nonce, envelope.wrapped_dek_nonce)));
            let blob = ciphertext_blob_id(&encoded);
            assert_ne!(previous_blob, Some(blob));
            previous_blob = Some(blob);
            assert_eq!(
                decrypt_object(&subkeys, &encoded).unwrap().1,
                b"canonical plaintext"
            );
        }
    }

    #[test]
    fn altered_ciphertext_and_wrong_vault_key_are_rejected() {
        let vault_id = [2; 16];
        let subkeys = VaultMasterKey::from_bytes([3; 32])
            .derive_subkeys(&vault_id)
            .unwrap();
        let encoded = encrypt_object(
            &subkeys,
            vault_id,
            [4; 16],
            9,
            ObjectType::Attachment,
            b"opaque attachment",
        )
        .unwrap();
        let mut altered = encoded.clone();
        let last = altered.last_mut().unwrap();
        *last ^= 1;
        assert!(decrypt_object(&subkeys, &altered).is_err());

        let wrong = VaultMasterKey::from_bytes([5; 32])
            .derive_subkeys(&vault_id)
            .unwrap();
        assert!(decrypt_object(&wrong, &encoded).is_err());
    }

    #[test]
    fn encrypted_object_matches_shared_known_answer_vector() {
        let vector = vector_section("object_envelope");
        let vault_id = vector_array(&vector, "vault_id_hex");
        let master = VaultMasterKey::from_bytes(vector_array(&vector, "vmk_hex"));
        let subkeys = master.derive_subkeys(&vault_id).unwrap();
        let dek = vector_array(&vector, "dek_hex");
        let encoded = super::encrypt_object_with_material(
            &subkeys,
            super::ObjectIdentity {
                vault_id,
                object_id: vector_array(&vector, "object_id_hex"),
                revision: vector["revision"].as_u64().unwrap(),
                object_type: ObjectType::try_from(
                    u8::try_from(vector["object_type"].as_u64().unwrap()).unwrap(),
                )
                .unwrap(),
            },
            vector_string(&vector, "plaintext_utf8").as_bytes(),
            super::EncryptionMaterial {
                dek: &dek,
                payload_nonce: vector_array(&vector, "payload_nonce_hex"),
                wrapped_dek_nonce: vector_array(&vector, "wrapped_dek_nonce_hex"),
            },
        )
        .unwrap();
        assert_eq!(hex::encode(&encoded), vector_string(&vector, "encoded_hex"));
        assert_eq!(
            hex::encode(ciphertext_blob_id(&encoded)),
            vector_string(&vector, "blob_id_hex")
        );
        assert_eq!(
            decrypt_object(&subkeys, &encoded).unwrap().1,
            vector_string(&vector, "plaintext_utf8").as_bytes()
        );
    }
}
