use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::array::Array;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use minicbor::{Decoder, Encoder};
use subtle::ConstantTimeEq;
use web_time::Instant;
use zeroize::{Zeroize, Zeroizing};

use crate::keys::{SecretKey, select_calibrated_policy};
use crate::{
    CIPHER_SUITE, ClientKdfPolicy, ClientPlatformClass, CryptoError, VaultMasterKey, random_array,
};

const CLIENT_KEK_LABEL: &[u8] = b"learning-loop/client-kek/v1\0";
const VMK_ENVELOPE_LABEL: &str = "learning-loop/vmk-envelope/v1";
const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 24;
const WRAPPED_VMK_BYTES: usize = 48;

/// Parsed password-wrapped vault master-key envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultKeyEnvelope {
    /// Client-password Argon2id salt.
    pub salt: [u8; SALT_BYTES],
    /// Persistable client KDF parameters.
    pub policy: ClientKdfPolicy,
    /// Fresh VMK wrapping nonce.
    pub nonce: [u8; NONCE_BYTES],
    /// Encrypted 32-byte VMK plus authentication tag.
    pub wrapped_vmk: Vec<u8>,
}

/// Benchmarks a bounded Argon2id baseline and selects a client KDF policy.
///
/// Desktop policies target roughly 500 ms inside the required 300–800 ms
/// range. Android policies target roughly 800 ms inside the required
/// 500–1200 ms range and never exceed 64 MiB.
///
/// # Errors
///
/// Returns a [`CryptoError`] for OS randomness, invalid parameters, or Argon2
/// failure.
pub fn calibrate_client_kdf(platform: ClientPlatformClass) -> Result<ClientKdfPolicy, CryptoError> {
    let memory_kib = platform.initial_memory_kib();
    let baseline = ClientKdfPolicy {
        memory_kib,
        iterations: 1,
        parallelism: 1,
    };
    let salt = random_array::<SALT_BYTES>()?;
    let calibration_input = Zeroizing::new(random_array::<32>()?);
    let mut output = Zeroizing::new([0_u8; 32]);
    let started = Instant::now();
    baseline
        .argon2()?
        .hash_password_into(&calibration_input[..], &salt, output.as_mut())
        .map_err(|_| CryptoError::Argon2)?;
    Ok(select_calibrated_policy(
        platform,
        memory_kib,
        started.elapsed(),
    ))
}

/// Generates a random VMK and returns it with a password-wrapped envelope.
///
/// # Errors
///
/// Returns a [`CryptoError`] for randomness, KDF, AEAD, or encoding failure.
pub fn create_vault_key_envelope(
    password: Zeroizing<String>,
    policy: ClientKdfPolicy,
) -> Result<(VaultMasterKey, Vec<u8>), CryptoError> {
    let master = VaultMasterKey::from_bytes(random_array::<32>()?);
    let envelope = wrap_vault_master_key(password, policy, &master)?;
    Ok((master, envelope))
}

/// Wraps an existing VMK with a client password and fresh salt/nonce.
///
/// # Errors
///
/// Returns a [`CryptoError`] for randomness, KDF, AEAD, or encoding failure.
pub fn wrap_vault_master_key(
    password: Zeroizing<String>,
    policy: ClientKdfPolicy,
    master: &VaultMasterKey,
) -> Result<Vec<u8>, CryptoError> {
    let salt = random_array::<SALT_BYTES>()?;
    let nonce = random_array::<NONCE_BYTES>()?;
    wrap_vault_master_key_with_material(password, policy, master, salt, nonce)
}

fn wrap_vault_master_key_with_material(
    password: Zeroizing<String>,
    policy: ClientKdfPolicy,
    master: &VaultMasterKey,
    salt: [u8; SALT_BYTES],
    nonce: [u8; NONCE_BYTES],
) -> Result<Vec<u8>, CryptoError> {
    let kek = derive_client_kek(password, &salt, policy)?;
    let mut envelope = VaultKeyEnvelope {
        salt,
        policy,
        nonce,
        wrapped_vmk: Vec::new(),
    };
    let aad = vault_key_aad(&envelope)?;
    envelope.wrapped_vmk = XChaCha20Poly1305::new(&Array(*kek.expose()))
        .encrypt(
            &Array(nonce),
            Payload {
                msg: master.expose(),
                aad: &aad,
            },
        )
        .map_err(|_| CryptoError::AuthenticatedEncryption)?;
    encode_vault_key_envelope(&envelope)
}

/// Derives a KEK and authenticates/decrypts a password-wrapped VMK.
///
/// # Errors
///
/// Returns a generic authenticated-encryption error for a wrong password or
/// altered envelope, without distinguishing the cause.
pub fn unlock_vault_master_key(
    password: Zeroizing<String>,
    encoded: &[u8],
) -> Result<VaultMasterKey, CryptoError> {
    let envelope = decode_vault_key_envelope(encoded)?;
    let kek = derive_client_kek(password, &envelope.salt, envelope.policy)?;
    let aad = vault_key_aad(&envelope)?;
    let plaintext = Zeroizing::new(
        XChaCha20Poly1305::new(&Array(*kek.expose()))
            .decrypt(
                &Array(envelope.nonce),
                Payload {
                    msg: &envelope.wrapped_vmk,
                    aad: &aad,
                },
            )
            .map_err(|_| CryptoError::AuthenticatedEncryption)?,
    );
    let bytes = plaintext
        .as_slice()
        .try_into()
        .map_err(|_| CryptoError::InvalidEnvelope)?;
    Ok(VaultMasterKey::from_bytes(bytes))
}

/// Decodes and exact-reencodes a VMK envelope.
///
/// # Errors
///
/// Returns a [`CryptoError`] for malformed, unsupported, trailing, or
/// non-deterministic CBOR.
pub fn decode_vault_key_envelope(encoded: &[u8]) -> Result<VaultKeyEnvelope, CryptoError> {
    if encoded.len() > 512 {
        return Err(CryptoError::EnvelopeLimit);
    }
    let mut decoder = Decoder::new(encoded);
    if decoder.map()? != Some(7) {
        return Err(CryptoError::InvalidEnvelope);
    }
    expect_key(&mut decoder, 0)?;
    if decoder.u16()? != ll_protocol::PROTOCOL_VERSION {
        return Err(CryptoError::InvalidEnvelope);
    }
    expect_key(&mut decoder, 1)?;
    let salt = fixed_bytes(decoder.bytes()?)?;
    expect_key(&mut decoder, 2)?;
    let memory_kib = decoder.u32()?;
    expect_key(&mut decoder, 3)?;
    let iterations = decoder.u32()?;
    expect_key(&mut decoder, 4)?;
    let parallelism = decoder.u32()?;
    let policy = ClientKdfPolicy {
        memory_kib,
        iterations,
        parallelism,
    };
    policy.argon2()?;
    expect_key(&mut decoder, 5)?;
    let nonce = fixed_bytes(decoder.bytes()?)?;
    expect_key(&mut decoder, 6)?;
    let wrapped_vmk = decoder.bytes()?.to_vec();
    if wrapped_vmk.len() != WRAPPED_VMK_BYTES {
        return Err(CryptoError::InvalidEnvelope);
    }
    let envelope = VaultKeyEnvelope {
        salt,
        policy,
        nonce,
        wrapped_vmk,
    };
    if decoder.position() != encoded.len()
        || !bool::from(encode_vault_key_envelope(&envelope)?.ct_eq(encoded))
    {
        return Err(CryptoError::InvalidEnvelope);
    }
    Ok(envelope)
}

fn derive_client_kek(
    mut password: Zeroizing<String>,
    salt: &[u8; SALT_BYTES],
    policy: ClientKdfPolicy,
) -> Result<SecretKey, CryptoError> {
    let mut domain_password =
        Zeroizing::new(Vec::with_capacity(CLIENT_KEK_LABEL.len() + password.len()));
    domain_password.extend_from_slice(CLIENT_KEK_LABEL);
    domain_password.extend_from_slice(password.as_bytes());
    password.zeroize();
    let mut output = [0_u8; 32];
    policy
        .argon2()?
        .hash_password_into(&domain_password, salt, &mut output)
        .map_err(|_| CryptoError::Argon2)?;
    Ok(SecretKey::new(output))
}

fn encode_vault_key_envelope(envelope: &VaultKeyEnvelope) -> Result<Vec<u8>, CryptoError> {
    let mut output = Vec::new();
    Encoder::new(&mut output)
        .map(7)?
        .u8(0)?
        .u16(ll_protocol::PROTOCOL_VERSION)?
        .u8(1)?
        .bytes(&envelope.salt)?
        .u8(2)?
        .u32(envelope.policy.memory_kib)?
        .u8(3)?
        .u32(envelope.policy.iterations)?
        .u8(4)?
        .u32(envelope.policy.parallelism)?
        .u8(5)?
        .bytes(&envelope.nonce)?
        .u8(6)?
        .bytes(&envelope.wrapped_vmk)?;
    Ok(output)
}

fn vault_key_aad(envelope: &VaultKeyEnvelope) -> Result<Vec<u8>, CryptoError> {
    let mut output = Vec::new();
    Encoder::new(&mut output)
        .array(7)?
        .str(VMK_ENVELOPE_LABEL)?
        .u16(ll_protocol::PROTOCOL_VERSION)?
        .bytes(&envelope.salt)?
        .u32(envelope.policy.memory_kib)?
        .u32(envelope.policy.iterations)?
        .u32(envelope.policy.parallelism)?
        .str(CIPHER_SUITE)?;
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
    use ll_testkit::random_test_password;

    use super::{
        ClientKdfPolicy, create_vault_key_envelope, decode_vault_key_envelope,
        unlock_vault_master_key,
    };

    const TEST_POLICY: ClientKdfPolicy = ClientKdfPolicy {
        memory_kib: ClientKdfPolicy::MIN_MEMORY_KIB,
        iterations: 1,
        parallelism: 1,
    };

    fn vector_section() -> serde_json::Value {
        serde_json::from_str::<serde_json::Value>(include_str!(
            "../../../protocol/test-vectors/encrypted-versioning-v1.json"
        ))
        .unwrap()["vault_key_envelope"]
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
    fn password_wrapped_vmk_round_trips_and_rejects_wrong_password() {
        let password = random_test_password().unwrap();
        let (master, encoded) = create_vault_key_envelope(password.clone(), TEST_POLICY).unwrap();
        let unlocked = unlock_vault_master_key(password, &encoded).unwrap();
        assert_eq!(master.expose(), unlocked.expose());
        assert!(unlock_vault_master_key(random_test_password().unwrap(), &encoded).is_err());
        assert_eq!(
            decode_vault_key_envelope(&encoded).unwrap().policy,
            TEST_POLICY
        );
    }

    #[test]
    fn vault_key_envelope_matches_shared_known_answer_vector() {
        let vector = vector_section();
        let master = crate::VaultMasterKey::from_bytes(vector_array(&vector, "vmk_hex"));
        let policy = ClientKdfPolicy {
            memory_kib: u32::try_from(vector["memory_kib"].as_u64().unwrap()).unwrap(),
            iterations: u32::try_from(vector["iterations"].as_u64().unwrap()).unwrap(),
            parallelism: u32::try_from(vector["parallelism"].as_u64().unwrap()).unwrap(),
        };
        let encoded = super::wrap_vault_master_key_with_material(
            zeroize::Zeroizing::new(vector_string(&vector, "kdf_input_utf8").to_owned()),
            policy,
            &master,
            vector_array(&vector, "salt_hex"),
            vector_array(&vector, "nonce_hex"),
        )
        .unwrap();
        assert_eq!(hex::encode(&encoded), vector_string(&vector, "encoded_hex"));
        let decoded = super::decode_vault_key_envelope(&encoded).unwrap();
        assert_eq!(decoded.policy, policy);
        let unlocked = super::unlock_vault_master_key(
            zeroize::Zeroizing::new(vector_string(&vector, "kdf_input_utf8").to_owned()),
            &encoded,
        )
        .unwrap();
        assert_eq!(unlocked.expose(), master.expose());
    }
}
