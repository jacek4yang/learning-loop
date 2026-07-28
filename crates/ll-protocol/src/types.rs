/// Public bootstrap data. Its server public key is trusted only after the
/// client compares the computed fingerprint with an out-of-band value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bootstrap {
    /// Protocol version.
    pub protocol_version: u16,
    /// Persistent random server instance identifier.
    pub instance_id: [u8; 16],
    /// Exact Noise suite.
    pub noise_suite: String,
    /// Persistent responder static public key.
    pub server_static_public_key: [u8; 32],
    /// Human-display fingerprint.
    pub server_fingerprint: String,
    /// Maximum accepted Noise handshake size.
    pub maximum_handshake_bytes: u32,
    /// Maximum accepted Noise transport ciphertext size.
    pub maximum_transport_bytes: u32,
}

/// Authenticated payload in the responder's final Noise handshake message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthChallenge {
    /// Opaque body-level session lookup handle.
    pub session_handle: [u8; 32],
    /// Persistent server-password Argon2 salt.
    pub authentication_salt: [u8; 16],
    /// Argon2 memory parameter in KiB.
    pub argon2_memory_kib: u32,
    /// Argon2 iteration count.
    pub argon2_iterations: u32,
    /// Argon2 parallelism.
    pub argon2_parallelism: u32,
    /// Fresh random authentication challenge.
    pub random_challenge: [u8; 32],
    /// Fresh short session identifier.
    pub session_id: [u8; 16],
}

/// A sequenced, encrypted client application message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientMessage {
    /// Must increase by exactly one in the client-to-server direction.
    pub sequence: u64,
    /// Application operation.
    pub request: Request,
}

/// A sequenced, encrypted server application message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerMessage {
    /// Must increase by exactly one in the server-to-client direction.
    pub sequence: u64,
    /// Application result.
    pub response: Response,
}

/// Client operations supported by the phase-1 object service.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Request {
    /// Proves knowledge of the independent server access password. An existing
    /// device also supplies its ID and an Ed25519 signature.
    Authenticate {
        /// HMAC-SHA-256 password proof.
        proof: [u8; 32],
        /// Existing device ID, if authenticating as a registered device.
        device_id: Option<[u8; 16]>,
        /// Existing device signature over the session authentication context.
        device_signature: Option<[u8; 64]>,
    },
    /// Registers or explicitly reauthorizes a device after password proof.
    RegisterDevice {
        /// Client-generated device ID.
        device_id: [u8; 16],
        /// Ed25519 verifying key.
        public_key: [u8; 32],
        /// VMK-encrypted user-visible device name.
        encrypted_name: Vec<u8>,
        /// Proof of possession over the registration context.
        signature: [u8; 64],
    },
    /// Lists opaque device records.
    ListDevices,
    /// Revokes a device immediately.
    RevokeDevice {
        /// Device to revoke.
        device_id: [u8; 16],
    },
    /// Starts a bounded resumable ciphertext upload.
    BeginUpload {
        /// Total ciphertext bytes.
        expected_size: u64,
        /// BLAKE3 of the complete ciphertext object.
        expected_hash: [u8; 32],
    },
    /// Appends one exact-offset ciphertext chunk.
    UploadChunk {
        /// Server-assigned upload ID.
        upload_id: [u8; 16],
        /// Required current offset.
        offset: u64,
        /// Ciphertext bytes.
        chunk: Vec<u8>,
    },
    /// Fsyncs, atomically publishes, and records an upload.
    CommitUpload {
        /// Server-assigned upload ID.
        upload_id: [u8; 16],
    },
    /// Downloads one bounded ciphertext range.
    GetBlob {
        /// BLAKE3 ciphertext object ID.
        blob_id: [u8; 32],
        /// Byte offset.
        offset: u64,
        /// Maximum returned bytes.
        maximum_bytes: u32,
    },
    /// Liveness request inside an authenticated channel.
    Ping,
}

/// Server results supported by phase 1.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Response {
    /// Password proof passed. `device_authenticated` is false only while a new
    /// device proceeds to registration.
    Authenticated {
        /// Whether this session has a registered, non-revoked device.
        device_authenticated: bool,
    },
    /// Device registration or reauthorization succeeded.
    DeviceRegistered,
    /// Opaque device list.
    Devices(Vec<DeviceRecord>),
    /// Device revocation succeeded.
    DeviceRevoked,
    /// Upload was allocated or resumed.
    UploadReady {
        /// Stable upload ID.
        upload_id: [u8; 16],
        /// Already persisted byte offset.
        offset: u64,
    },
    /// One upload chunk was persisted.
    ChunkAccepted {
        /// New persisted byte offset.
        offset: u64,
    },
    /// Object was atomically published.
    UploadCommitted {
        /// Ciphertext object ID.
        blob_id: [u8; 32],
    },
    /// One bounded ciphertext range.
    BlobChunk {
        /// Requested byte offset.
        offset: u64,
        /// Total ciphertext object size.
        total_size: u64,
        /// True when this chunk reaches the end.
        complete: bool,
        /// Ciphertext bytes.
        chunk: Vec<u8>,
    },
    /// Liveness response.
    Pong,
    /// Stable error without reflected untrusted text.
    Error(ErrorCode),
}

/// Opaque device record returned to an authenticated device.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeviceRecord {
    /// Device ID.
    pub device_id: [u8; 16],
    /// Ed25519 verifying key.
    pub public_key: [u8; 32],
    /// VMK-encrypted display name.
    pub encrypted_name: Vec<u8>,
    /// Whether the device is revoked.
    pub revoked: bool,
}

/// Stable encrypted application error codes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u16)]
pub enum ErrorCode {
    /// Message or operation is invalid for the current session phase.
    InvalidState = 1,
    /// Password or device authentication failed.
    AuthenticationFailed = 2,
    /// A registered device is required.
    DeviceRequired = 3,
    /// Device is unknown.
    DeviceNotFound = 4,
    /// Device was revoked.
    DeviceRevoked = 5,
    /// Signature failed verification.
    InvalidSignature = 6,
    /// Request exceeds a hard size limit.
    RequestTooLarge = 7,
    /// Request sequence or upload offset is not the next value.
    SequenceMismatch = 8,
    /// Upload was not found.
    UploadNotFound = 9,
    /// Ciphertext hash or length does not match.
    IntegrityFailure = 10,
    /// Blob was not found.
    BlobNotFound = 11,
    /// Server has insufficient durable capacity.
    InsufficientStorage = 12,
    /// Built-in rate limit is active.
    RateLimited = 13,
    /// Safe generic internal failure.
    TemporarilyUnavailable = 14,
}

impl TryFrom<u16> for ErrorCode {
    type Error = ();

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::InvalidState),
            2 => Ok(Self::AuthenticationFailed),
            3 => Ok(Self::DeviceRequired),
            4 => Ok(Self::DeviceNotFound),
            5 => Ok(Self::DeviceRevoked),
            6 => Ok(Self::InvalidSignature),
            7 => Ok(Self::RequestTooLarge),
            8 => Ok(Self::SequenceMismatch),
            9 => Ok(Self::UploadNotFound),
            10 => Ok(Self::IntegrityFailure),
            11 => Ok(Self::BlobNotFound),
            12 => Ok(Self::InsufficientStorage),
            13 => Ok(Self::RateLimited),
            14 => Ok(Self::TemporarilyUnavailable),
            _ => Err(()),
        }
    }
}
