//! Mature-library-backed cryptographic boundaries for Learning Loop.
//!
//! This crate composes Argon2id, HMAC-SHA-256, X25519/Noise, SHA-256,
//! Ed25519, and zeroization. It does not implement cryptographic primitives.

mod device;
mod error;
mod identity;
mod noise;
mod password;
mod random;

pub use device::{
    device_auth_signature_context, registration_signature_context, verify_device_signature,
};
pub use error::CryptoError;
pub use identity::ServerIdentity;
pub use noise::{
    AcceptedHandshake, accept_handshake, build_initiator, decrypt_transport_records,
    encrypt_transport_records,
};
pub use password::{
    Argon2Policy, ServerAuthKey, authentication_context, derive_server_auth_key, password_proof,
    server_auth_verifier, verify_password_proof, verify_server_auth_verifier,
};
pub use random::random_array;
