use thiserror::Error;

/// Deterministic format, graph, or signature validation failure.
#[derive(Debug, Error)]
pub enum VersioningError {
    /// Deterministic CBOR encoding failed.
    #[error("version data encoding failed")]
    Encode(#[from] minicbor::encode::Error<std::convert::Infallible>),
    /// CBOR decoding failed.
    #[error("version data decoding failed")]
    Decode(#[from] minicbor::decode::Error),
    /// A field or aggregate exceeds a built-in limit.
    #[error("version data exceeds a limit")]
    LimitExceeded,
    /// Input is malformed, unsupported, or not exact deterministic encoding.
    #[error("version data is invalid or non-deterministic")]
    InvalidFormat,
    /// A commit ID differs from the domain-separated envelope hash.
    #[error("commit identifier is invalid")]
    InvalidCommitId,
    /// A commit signature or public key is invalid.
    #[error("commit signature is invalid")]
    InvalidSignature,
    /// A parent commit is absent.
    #[error("parent commit is missing")]
    MissingParent,
    /// A non-root commit omitted its parents or a second root was attempted.
    #[error("commit root rule is invalid")]
    InvalidRoot,
    /// A commit identifier already maps to different data.
    #[error("commit identifier collision")]
    CommitCollision,
    /// The graph has no requested commit.
    #[error("commit was not found")]
    CommitNotFound,
    /// An encrypted commit body envelope is invalid.
    #[error("encrypted commit body is invalid")]
    InvalidEncryptedBody,
}
