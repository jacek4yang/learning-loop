use thiserror::Error;

/// Portable client protocol, state, or cryptographic failure.
#[derive(Debug, Error)]
pub enum ClientError {
    /// Public bootstrap bytes or pinned identity are invalid.
    #[error("server bootstrap or fingerprint is invalid")]
    InvalidBootstrap,
    /// An operation is not valid in the current channel state.
    #[error("client channel state is invalid")]
    InvalidState,
    /// A fixed-size field has the wrong length.
    #[error("client field has invalid length")]
    InvalidLength,
    /// A server response has the wrong session or application sequence.
    #[error("server response sequence is invalid")]
    InvalidSequence,
    /// Cryptographic operation failed.
    #[error("client cryptographic operation failed")]
    Crypto(#[from] ll_crypto::CryptoError),
    /// Protocol encoding or decoding failed.
    #[error("client protocol operation failed")]
    Protocol(#[from] ll_protocol::CodecError),
    /// Transport framing failed.
    #[error("client transport framing failed")]
    Frame(#[from] ll_protocol::FrameError),
    /// Commit or manifest operation failed.
    #[error("client version operation failed")]
    Versioning(#[from] ll_versioning::VersioningError),
    /// Noise state transition failed.
    #[error("client Noise operation failed")]
    Noise(#[from] snow::Error),
}
