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
