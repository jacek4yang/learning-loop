//! Protocol hard limits applied before allocation or persistent writes.

/// Maximum cleartext Noise handshake message.
pub const MAX_HANDSHAKE_BYTES: usize = 4096;

/// Maximum encrypted application ciphertext in one HTTP request.
pub const MAX_TRANSPORT_CIPHERTEXT_BYTES: usize = 1024 * 1024;

/// Maximum total HTTP body accepted by protocol routes.
pub const MAX_HTTP_BODY_BYTES: usize = MAX_TRANSPORT_CIPHERTEXT_BYTES + 64;

/// Maximum chunk carried in one encrypted upload message.
pub const MAX_CHUNK_BYTES: usize = 256 * 1024;

/// Maximum ciphertext object size accepted by the server.
pub const MAX_OBJECT_BYTES: u64 = 512 * 1024 * 1024;

/// Maximum encrypted display-name payload for one device.
pub const MAX_ENCRYPTED_DEVICE_NAME_BYTES: usize = 4096;

/// Maximum complete deterministic signed commit record.
pub const MAX_SIGNED_COMMIT_BYTES: usize = 264 * 1024;

/// Maximum commit IDs a client may advertise as already known.
pub const MAX_KNOWN_COMMITS: usize = 2048;

/// Maximum concurrent head count returned by the service.
pub const MAX_HEADS: usize = 1024;

/// Maximum commit records returned in one bounded changes response.
pub const MAX_CHANGES_PER_RESPONSE: usize = 3;
