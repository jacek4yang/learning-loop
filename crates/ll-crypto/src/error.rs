use thiserror::Error;

/// Cryptographic setup, derivation, handshake, or verification failure.
#[derive(Debug, Error)]
pub enum CryptoError {
    /// Operating-system randomness was unavailable.
    #[error("secure randomness is unavailable")]
    Random(#[from] getrandom::Error),
    /// Persistent server identity is truncated, inconsistent, or unreadable.
    #[error("server identity is invalid")]
    InvalidIdentity,
    /// Persistent server identity file I/O failed.
    #[error("server identity I/O failed")]
    IdentityIo(#[from] std::io::Error),
    /// Argon2 policy is invalid.
    #[error("Argon2 parameters are invalid")]
    InvalidArgon2Policy,
    /// Argon2 derivation failed.
    #[error("Argon2 derivation failed")]
    Argon2,
    /// Password proof or persistent verifier failed.
    #[error("authentication failed")]
    AuthenticationFailed,
    /// Noise suite setup or message processing failed.
    #[error("Noise protocol failed")]
    Noise(#[from] snow::Error),
    /// A length-prefixed Noise transport record stream is malformed or too large.
    #[error("Noise transport record stream is invalid")]
    InvalidTransportRecords,
    /// Protocol transcript data could not be encoded.
    #[error("protocol transcript encoding failed")]
    Protocol(#[from] ll_protocol::CodecError),
    /// Ed25519 public key or signature is invalid.
    #[error("device signature is invalid")]
    InvalidDeviceSignature,
}
