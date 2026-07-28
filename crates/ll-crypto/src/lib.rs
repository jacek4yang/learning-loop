//! Mature-library-backed cryptographic boundaries for Learning Loop.
//!
//! This crate composes Argon2id, HMAC-SHA-256, X25519/Noise, SHA-256,
//! Ed25519, and zeroization. It does not implement cryptographic primitives.

mod device;
mod error;
mod identity;
mod keys;
mod noise;
mod object;
mod password;
mod random;
mod vault;

pub use device::{
    device_auth_signature_context, registration_signature_context, verify_device_signature,
};
pub use error::CryptoError;
pub use identity::{ServerIdentity, server_fingerprint};
pub use keys::{ClientKdfPolicy, ClientPlatformClass, VaultMasterKey, VaultSubkeys};
pub use noise::{
    AcceptedHandshake, accept_handshake, build_initiator, decrypt_transport_records,
    encrypt_transport_records,
};
pub use object::{
    CIPHER_SUITE, ObjectEnvelope, ObjectType, ciphertext_blob_id, decode_object_envelope,
    decrypt_object, encrypt_object,
};
pub use password::{
    Argon2Policy, ServerAuthKey, authentication_context, derive_server_auth_key, password_proof,
    server_auth_verifier, verify_password_proof, verify_server_auth_verifier,
};
pub use random::random_array;
pub use vault::{
    VaultKeyEnvelope, calibrate_client_kdf, create_vault_key_envelope, decode_vault_key_envelope,
    unlock_vault_master_key, wrap_vault_master_key,
};
