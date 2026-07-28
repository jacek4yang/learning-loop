//! Bounded, deterministic wire types for Learning Loop protocol version 1.

mod codec;
mod frame;
mod limits;
mod types;

pub use codec::{
    CodecError, decode_auth_challenge, decode_bootstrap, decode_client_message,
    decode_server_message, encode_auth_challenge, encode_bootstrap, encode_client_message,
    encode_noise_prologue, encode_server_message,
};
pub use frame::{FRAME_MAGIC, TransportFrame, decode_transport_frame, encode_transport_frame};
pub use limits::{
    MAX_CHUNK_BYTES, MAX_ENCRYPTED_DEVICE_NAME_BYTES, MAX_HANDSHAKE_BYTES, MAX_HTTP_BODY_BYTES,
    MAX_OBJECT_BYTES, MAX_TRANSPORT_CIPHERTEXT_BYTES,
};
pub use types::{
    AuthChallenge, Bootstrap, ClientMessage, DeviceRecord, ErrorCode, Request, Response,
    ServerMessage,
};

/// The only supported wire protocol version.
pub const PROTOCOL_VERSION: u16 = 1;

/// The fixed Noise suite for protocol version 1.
pub const NOISE_SUITE: &str = "Noise_NK_25519_ChaChaPoly_BLAKE2s";
