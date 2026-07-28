use ll_protocol::ErrorCode;
use thiserror::Error;

/// Reliable storage operation failure.
#[derive(Debug, Error)]
pub enum StorageError {
    /// `SQLite` operation failed.
    #[error("database operation failed")]
    Database(#[from] rusqlite::Error),
    /// Filesystem operation failed.
    #[error("storage I/O failed")]
    Io(#[from] std::io::Error),
    /// Background blocking task failed.
    #[error("storage worker failed")]
    Join(#[from] tokio::task::JoinError),
    /// Persistent metadata has an invalid fixed length or value.
    #[error("persistent metadata is corrupt")]
    CorruptMetadata,
    /// Device is missing.
    #[error("device was not found")]
    DeviceNotFound,
    /// Device is revoked.
    #[error("device is revoked")]
    DeviceRevoked,
    /// Upload is missing.
    #[error("upload was not found")]
    UploadNotFound,
    /// Blob is missing.
    #[error("blob was not found")]
    BlobNotFound,
    /// Offset or sequence does not match.
    #[error("offset does not match")]
    OffsetMismatch,
    /// Size exceeds a built-in limit.
    #[error("storage limit exceeded")]
    LimitExceeded,
    /// Disk reserve would be violated.
    #[error("insufficient durable storage")]
    InsufficientStorage,
    /// Ciphertext length or hash differs.
    #[error("ciphertext integrity check failed")]
    IntegrityFailure,
    /// Stored server access password verifier differs.
    #[error("configured server password does not match persistent verifier")]
    PasswordMismatch,
    /// Cryptographic initialization failed.
    #[error("cryptographic initialization failed")]
    Crypto(#[from] ll_crypto::CryptoError),
}

impl StorageError {
    /// Maps an internal storage category to a stable encrypted protocol code.
    #[must_use]
    pub const fn protocol_code(&self) -> ErrorCode {
        match self {
            Self::DeviceNotFound => ErrorCode::DeviceNotFound,
            Self::DeviceRevoked => ErrorCode::DeviceRevoked,
            Self::UploadNotFound => ErrorCode::UploadNotFound,
            Self::BlobNotFound => ErrorCode::BlobNotFound,
            Self::OffsetMismatch => ErrorCode::SequenceMismatch,
            Self::LimitExceeded => ErrorCode::RequestTooLarge,
            Self::InsufficientStorage => ErrorCode::InsufficientStorage,
            Self::IntegrityFailure | Self::CorruptMetadata => ErrorCode::IntegrityFailure,
            Self::PasswordMismatch => ErrorCode::AuthenticationFailed,
            Self::Database(_) | Self::Io(_) | Self::Join(_) | Self::Crypto(_) => {
                ErrorCode::TemporarilyUnavailable
            }
        }
    }
}
