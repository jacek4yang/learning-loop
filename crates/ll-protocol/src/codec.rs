use minicbor::{Decoder, Encoder, decode, encode};
use thiserror::Error;

use crate::{
    AuthChallenge, Bootstrap, ClientMessage, DeviceRecord, ErrorCode, MAX_CHANGES_PER_RESPONSE,
    MAX_CHUNK_BYTES, MAX_ENCRYPTED_DEVICE_NAME_BYTES, MAX_HEADS, MAX_KNOWN_COMMITS,
    MAX_SIGNED_COMMIT_BYTES, NOISE_SUITE, PROTOCOL_VERSION, Request, Response, ServerMessage,
};

const TYPE_AUTHENTICATE: u8 = 1;
const TYPE_REGISTER_DEVICE: u8 = 2;
const TYPE_LIST_DEVICES: u8 = 3;
const TYPE_REVOKE_DEVICE: u8 = 4;
const TYPE_BEGIN_UPLOAD: u8 = 5;
const TYPE_UPLOAD_CHUNK: u8 = 6;
const TYPE_COMMIT_UPLOAD: u8 = 7;
const TYPE_GET_BLOB: u8 = 8;
const TYPE_PING: u8 = 9;
const TYPE_PUT_COMMIT: u8 = 10;
const TYPE_GET_COMMIT: u8 = 11;
const TYPE_GET_HEADS: u8 = 12;
const TYPE_GET_CHANGES: u8 = 13;

const RESPONSE_AUTHENTICATED: u8 = 1;
const RESPONSE_DEVICE_REGISTERED: u8 = 2;
const RESPONSE_DEVICES: u8 = 3;
const RESPONSE_DEVICE_REVOKED: u8 = 4;
const RESPONSE_UPLOAD_READY: u8 = 5;
const RESPONSE_CHUNK_ACCEPTED: u8 = 6;
const RESPONSE_UPLOAD_COMMITTED: u8 = 7;
const RESPONSE_BLOB_CHUNK: u8 = 8;
const RESPONSE_PONG: u8 = 9;
const RESPONSE_COMMIT_STORED: u8 = 10;
const RESPONSE_COMMIT_RECORD: u8 = 11;
const RESPONSE_HEADS: u8 = 12;
const RESPONSE_CHANGES: u8 = 13;
const RESPONSE_ERROR: u8 = 255;

/// Deterministic CBOR encoding or decoding failure.
#[derive(Debug, Error)]
pub enum CodecError {
    /// CBOR encoding failed.
    #[error("CBOR encoding failed")]
    Encode(#[from] encode::Error<std::convert::Infallible>),
    /// CBOR decoding failed or violated the fixed schema.
    #[error("CBOR decoding failed")]
    Decode(#[from] decode::Error),
    /// Input used a valid but non-deterministic representation.
    #[error("non-deterministic CBOR is forbidden")]
    NonDeterministic,
    /// A fixed-size byte field has an invalid length.
    #[error("fixed byte field has invalid length")]
    InvalidByteLength,
    /// A collection or byte string exceeds a hard limit.
    #[error("field exceeds a hard limit")]
    LimitExceeded,
    /// Protocol version or enum discriminator is unknown.
    #[error("unsupported protocol value")]
    UnsupportedValue,
    /// Optional fields violate their paired schema.
    #[error("invalid optional field combination")]
    InvalidCombination,
}

/// Encodes the exact Noise prologue bound into the handshake transcript.
///
/// # Errors
///
/// Returns a [`CodecError`] if a value cannot be encoded.
pub fn encode_noise_prologue(instance_id: &[u8; 16]) -> Result<Vec<u8>, CodecError> {
    let mut output = Vec::new();
    let mut encoder = Encoder::new(&mut output);
    encoder
        .array(4)?
        .str("learning-loop")?
        .u16(PROTOCOL_VERSION)?
        .bytes(instance_id)?
        .str(NOISE_SUITE)?;
    Ok(output)
}

/// Encodes public bootstrap data in fixed field order.
///
/// # Errors
///
/// Returns a [`CodecError`] if a value cannot be encoded.
pub fn encode_bootstrap(value: &Bootstrap) -> Result<Vec<u8>, CodecError> {
    let mut output = Vec::new();
    let mut encoder = Encoder::new(&mut output);
    encoder
        .array(7)?
        .u16(value.protocol_version)?
        .bytes(&value.instance_id)?
        .str(&value.noise_suite)?
        .bytes(&value.server_static_public_key)?
        .str(&value.server_fingerprint)?
        .u32(value.maximum_handshake_bytes)?
        .u32(value.maximum_transport_bytes)?;
    Ok(output)
}

/// Decodes and checks deterministic public bootstrap data.
///
/// # Errors
///
/// Returns a [`CodecError`] for malformed, unsupported, or non-deterministic
/// input.
pub fn decode_bootstrap(input: &[u8]) -> Result<Bootstrap, CodecError> {
    let mut decoder = Decoder::new(input);
    expect_array(&mut decoder, 7)?;
    let value = Bootstrap {
        protocol_version: decoder.u16()?,
        instance_id: fixed_bytes(decoder.bytes()?)?,
        noise_suite: decoder.str()?.to_owned(),
        server_static_public_key: fixed_bytes(decoder.bytes()?)?,
        server_fingerprint: decoder.str()?.to_owned(),
        maximum_handshake_bytes: decoder.u32()?,
        maximum_transport_bytes: decoder.u32()?,
    };
    finish(&decoder, input)?;
    if value.protocol_version != PROTOCOL_VERSION || value.noise_suite != NOISE_SUITE {
        return Err(CodecError::UnsupportedValue);
    }
    ensure_deterministic(input, &encode_bootstrap(&value)?).map(|()| value)
}

/// Encodes the authenticated payload carried by the final Noise handshake.
///
/// # Errors
///
/// Returns a [`CodecError`] if a value cannot be encoded.
pub fn encode_auth_challenge(value: &AuthChallenge) -> Result<Vec<u8>, CodecError> {
    let mut output = Vec::new();
    let mut encoder = Encoder::new(&mut output);
    encoder
        .array(7)?
        .bytes(&value.session_handle)?
        .bytes(&value.authentication_salt)?
        .u32(value.argon2_memory_kib)?
        .u32(value.argon2_iterations)?
        .u32(value.argon2_parallelism)?
        .bytes(&value.random_challenge)?
        .bytes(&value.session_id)?;
    Ok(output)
}

/// Decodes and checks the authenticated Noise handshake payload.
///
/// # Errors
///
/// Returns a [`CodecError`] for malformed or non-deterministic input.
pub fn decode_auth_challenge(input: &[u8]) -> Result<AuthChallenge, CodecError> {
    let mut decoder = Decoder::new(input);
    expect_array(&mut decoder, 7)?;
    let value = AuthChallenge {
        session_handle: fixed_bytes(decoder.bytes()?)?,
        authentication_salt: fixed_bytes(decoder.bytes()?)?,
        argon2_memory_kib: decoder.u32()?,
        argon2_iterations: decoder.u32()?,
        argon2_parallelism: decoder.u32()?,
        random_challenge: fixed_bytes(decoder.bytes()?)?,
        session_id: fixed_bytes(decoder.bytes()?)?,
    };
    finish(&decoder, input)?;
    ensure_deterministic(input, &encode_auth_challenge(&value)?).map(|()| value)
}

/// Encodes one client message.
///
/// # Errors
///
/// Returns a [`CodecError`] for a field over a hard limit.
pub fn encode_client_message(value: &ClientMessage) -> Result<Vec<u8>, CodecError> {
    let mut output = Vec::new();
    let mut encoder = Encoder::new(&mut output);
    encoder
        .array(3)?
        .u16(PROTOCOL_VERSION)?
        .u64(value.sequence)?;
    encode_request(&mut encoder, &value.request)?;
    Ok(output)
}

/// Decodes one bounded deterministic client message.
///
/// # Errors
///
/// Returns a [`CodecError`] for malformed, oversized, unsupported, or
/// non-deterministic input.
pub fn decode_client_message(input: &[u8]) -> Result<ClientMessage, CodecError> {
    let mut decoder = Decoder::new(input);
    expect_array(&mut decoder, 3)?;
    if decoder.u16()? != PROTOCOL_VERSION {
        return Err(CodecError::UnsupportedValue);
    }
    let value = ClientMessage {
        sequence: decoder.u64()?,
        request: decode_request(&mut decoder)?,
    };
    finish(&decoder, input)?;
    ensure_deterministic(input, &encode_client_message(&value)?).map(|()| value)
}

/// Encodes one server message.
///
/// # Errors
///
/// Returns a [`CodecError`] for a field over a hard limit.
pub fn encode_server_message(value: &ServerMessage) -> Result<Vec<u8>, CodecError> {
    let mut output = Vec::new();
    let mut encoder = Encoder::new(&mut output);
    encoder
        .array(3)?
        .u16(PROTOCOL_VERSION)?
        .u64(value.sequence)?;
    encode_response(&mut encoder, &value.response)?;
    Ok(output)
}

/// Decodes one bounded deterministic server message.
///
/// # Errors
///
/// Returns a [`CodecError`] for malformed, oversized, unsupported, or
/// non-deterministic input.
pub fn decode_server_message(input: &[u8]) -> Result<ServerMessage, CodecError> {
    let mut decoder = Decoder::new(input);
    expect_array(&mut decoder, 3)?;
    if decoder.u16()? != PROTOCOL_VERSION {
        return Err(CodecError::UnsupportedValue);
    }
    let value = ServerMessage {
        sequence: decoder.u64()?,
        response: decode_response(&mut decoder)?,
    };
    finish(&decoder, input)?;
    ensure_deterministic(input, &encode_server_message(&value)?).map(|()| value)
}

fn encode_request<W: encode::Write>(
    encoder: &mut Encoder<W>,
    request: &Request,
) -> Result<(), encode::Error<W::Error>> {
    match request {
        Request::Authenticate {
            proof,
            device_id,
            device_signature,
        } => {
            encoder.array(4)?.u8(TYPE_AUTHENTICATE)?.bytes(proof)?;
            encode_optional_bytes(encoder, device_id.as_ref().map(<[u8; 16]>::as_slice))?;
            encode_optional_bytes(encoder, device_signature.as_ref().map(<[u8; 64]>::as_slice))?;
        }
        Request::RegisterDevice {
            device_id,
            public_key,
            encrypted_name,
            signature,
        } => {
            encoder
                .array(5)?
                .u8(TYPE_REGISTER_DEVICE)?
                .bytes(device_id)?
                .bytes(public_key)?
                .bytes(encrypted_name)?
                .bytes(signature)?;
        }
        Request::ListDevices => {
            encoder.array(1)?.u8(TYPE_LIST_DEVICES)?;
        }
        Request::RevokeDevice { device_id } => {
            encoder.array(2)?.u8(TYPE_REVOKE_DEVICE)?.bytes(device_id)?;
        }
        Request::BeginUpload {
            expected_size,
            expected_hash,
        } => {
            encoder
                .array(3)?
                .u8(TYPE_BEGIN_UPLOAD)?
                .u64(*expected_size)?
                .bytes(expected_hash)?;
        }
        Request::UploadChunk {
            upload_id,
            offset,
            chunk,
        } => {
            encoder
                .array(4)?
                .u8(TYPE_UPLOAD_CHUNK)?
                .bytes(upload_id)?
                .u64(*offset)?
                .bytes(chunk)?;
        }
        Request::CommitUpload { upload_id } => {
            encoder.array(2)?.u8(TYPE_COMMIT_UPLOAD)?.bytes(upload_id)?;
        }
        Request::GetBlob {
            blob_id,
            offset,
            maximum_bytes,
        } => {
            encoder
                .array(4)?
                .u8(TYPE_GET_BLOB)?
                .bytes(blob_id)?
                .u64(*offset)?
                .u32(*maximum_bytes)?;
        }
        Request::PutCommit { signed_commit } => {
            encoder
                .array(2)?
                .u8(TYPE_PUT_COMMIT)?
                .bytes(signed_commit)?;
        }
        Request::GetCommit { commit_id } => {
            encoder.array(2)?.u8(TYPE_GET_COMMIT)?.bytes(commit_id)?;
        }
        Request::GetHeads => {
            encoder.array(1)?.u8(TYPE_GET_HEADS)?;
        }
        Request::GetChanges {
            known_commit_ids,
            maximum_commits,
        } => {
            encoder.array(3)?.u8(TYPE_GET_CHANGES)?;
            encode_fixed_array(encoder, known_commit_ids)?;
            encoder.u16(*maximum_commits)?;
        }
        Request::Ping => {
            encoder.array(1)?.u8(TYPE_PING)?;
        }
    }
    Ok(())
}

fn decode_request(decoder: &mut Decoder<'_>) -> Result<Request, CodecError> {
    let length = definite_array(decoder)?;
    let discriminator = decoder.u8()?;
    match discriminator {
        TYPE_AUTHENTICATE if length == 4 => {
            let proof = fixed_bytes(decoder.bytes()?)?;
            let device_id = decode_optional_fixed::<16>(decoder)?;
            let device_signature = decode_optional_fixed::<64>(decoder)?;
            if device_id.is_some() != device_signature.is_some() {
                return Err(CodecError::InvalidCombination);
            }
            Ok(Request::Authenticate {
                proof,
                device_id,
                device_signature,
            })
        }
        TYPE_REGISTER_DEVICE if length == 5 => {
            let device_id = fixed_bytes(decoder.bytes()?)?;
            let public_key = fixed_bytes(decoder.bytes()?)?;
            let encrypted_name = bounded_bytes(decoder, MAX_ENCRYPTED_DEVICE_NAME_BYTES)?;
            let signature = fixed_bytes(decoder.bytes()?)?;
            Ok(Request::RegisterDevice {
                device_id,
                public_key,
                encrypted_name,
                signature,
            })
        }
        TYPE_LIST_DEVICES if length == 1 => Ok(Request::ListDevices),
        TYPE_REVOKE_DEVICE if length == 2 => Ok(Request::RevokeDevice {
            device_id: fixed_bytes(decoder.bytes()?)?,
        }),
        TYPE_BEGIN_UPLOAD if length == 3 => Ok(Request::BeginUpload {
            expected_size: decoder.u64()?,
            expected_hash: fixed_bytes(decoder.bytes()?)?,
        }),
        TYPE_UPLOAD_CHUNK if length == 4 => Ok(Request::UploadChunk {
            upload_id: fixed_bytes(decoder.bytes()?)?,
            offset: decoder.u64()?,
            chunk: bounded_bytes(decoder, MAX_CHUNK_BYTES)?,
        }),
        TYPE_COMMIT_UPLOAD if length == 2 => Ok(Request::CommitUpload {
            upload_id: fixed_bytes(decoder.bytes()?)?,
        }),
        TYPE_GET_BLOB if length == 4 => Ok(Request::GetBlob {
            blob_id: fixed_bytes(decoder.bytes()?)?,
            offset: decoder.u64()?,
            maximum_bytes: decoder.u32()?,
        }),
        TYPE_PUT_COMMIT if length == 2 => Ok(Request::PutCommit {
            signed_commit: bounded_bytes(decoder, MAX_SIGNED_COMMIT_BYTES)?,
        }),
        TYPE_GET_COMMIT if length == 2 => Ok(Request::GetCommit {
            commit_id: fixed_bytes(decoder.bytes()?)?,
        }),
        TYPE_GET_HEADS if length == 1 => Ok(Request::GetHeads),
        TYPE_GET_CHANGES if length == 3 => {
            let known_commit_ids = decode_fixed_array(decoder, MAX_KNOWN_COMMITS)?;
            let maximum_commits = decoder.u16()?;
            if maximum_commits == 0 || usize::from(maximum_commits) > MAX_CHANGES_PER_RESPONSE {
                return Err(CodecError::LimitExceeded);
            }
            Ok(Request::GetChanges {
                known_commit_ids,
                maximum_commits,
            })
        }
        TYPE_PING if length == 1 => Ok(Request::Ping),
        _ => Err(CodecError::UnsupportedValue),
    }
}

fn encode_response<W: encode::Write>(
    encoder: &mut Encoder<W>,
    response: &Response,
) -> Result<(), encode::Error<W::Error>> {
    match response {
        Response::Authenticated {
            device_authenticated,
            vault_id,
        } => {
            encoder
                .array(3)?
                .u8(RESPONSE_AUTHENTICATED)?
                .bool(*device_authenticated)?
                .bytes(vault_id)?;
        }
        Response::DeviceRegistered => {
            encoder.array(1)?.u8(RESPONSE_DEVICE_REGISTERED)?;
        }
        Response::Devices(devices) => {
            encoder.array(2)?.u8(RESPONSE_DEVICES)?;
            encoder.array(devices.len() as u64)?;
            for device in devices {
                encoder
                    .array(4)?
                    .bytes(&device.device_id)?
                    .bytes(&device.public_key)?
                    .bytes(&device.encrypted_name)?
                    .bool(device.revoked)?;
            }
        }
        Response::DeviceRevoked => {
            encoder.array(1)?.u8(RESPONSE_DEVICE_REVOKED)?;
        }
        Response::UploadReady { upload_id, offset } => {
            encoder
                .array(3)?
                .u8(RESPONSE_UPLOAD_READY)?
                .bytes(upload_id)?
                .u64(*offset)?;
        }
        Response::ChunkAccepted { offset } => {
            encoder
                .array(2)?
                .u8(RESPONSE_CHUNK_ACCEPTED)?
                .u64(*offset)?;
        }
        Response::UploadCommitted { blob_id } => {
            encoder
                .array(2)?
                .u8(RESPONSE_UPLOAD_COMMITTED)?
                .bytes(blob_id)?;
        }
        Response::BlobChunk {
            offset,
            total_size,
            complete,
            chunk,
        } => {
            encoder
                .array(5)?
                .u8(RESPONSE_BLOB_CHUNK)?
                .u64(*offset)?
                .u64(*total_size)?
                .bool(*complete)?
                .bytes(chunk)?;
        }
        Response::CommitStored { commit_id, heads } => {
            encoder
                .array(3)?
                .u8(RESPONSE_COMMIT_STORED)?
                .bytes(commit_id)?;
            encode_fixed_array(encoder, heads)?;
        }
        Response::CommitRecord { signed_commit } => {
            encoder
                .array(2)?
                .u8(RESPONSE_COMMIT_RECORD)?
                .bytes(signed_commit)?;
        }
        Response::Heads(heads) => {
            encoder.array(2)?.u8(RESPONSE_HEADS)?;
            encode_fixed_array(encoder, heads)?;
        }
        Response::Changes { commits, has_more } => {
            encoder.array(3)?.u8(RESPONSE_CHANGES)?;
            encoder.array(commits.len() as u64)?;
            for commit in commits {
                encoder.bytes(commit)?;
            }
            encoder.bool(*has_more)?;
        }
        Response::Pong => {
            encoder.array(1)?.u8(RESPONSE_PONG)?;
        }
        Response::Error(code) => {
            encoder.array(2)?.u8(RESPONSE_ERROR)?.u16(*code as u16)?;
        }
    }
    Ok(())
}

fn decode_response(decoder: &mut Decoder<'_>) -> Result<Response, CodecError> {
    let length = definite_array(decoder)?;
    let discriminator = decoder.u8()?;
    match discriminator {
        RESPONSE_AUTHENTICATED if length == 3 => Ok(Response::Authenticated {
            device_authenticated: decoder.bool()?,
            vault_id: fixed_bytes(decoder.bytes()?)?,
        }),
        RESPONSE_DEVICE_REGISTERED if length == 1 => Ok(Response::DeviceRegistered),
        RESPONSE_DEVICES if length == 2 => {
            let count = definite_array(decoder)?;
            if count > 1024 {
                return Err(CodecError::LimitExceeded);
            }
            let mut devices = Vec::with_capacity(count);
            for _ in 0..count {
                expect_array(decoder, 4)?;
                devices.push(DeviceRecord {
                    device_id: fixed_bytes(decoder.bytes()?)?,
                    public_key: fixed_bytes(decoder.bytes()?)?,
                    encrypted_name: bounded_bytes(decoder, MAX_ENCRYPTED_DEVICE_NAME_BYTES)?,
                    revoked: decoder.bool()?,
                });
            }
            Ok(Response::Devices(devices))
        }
        RESPONSE_DEVICE_REVOKED if length == 1 => Ok(Response::DeviceRevoked),
        RESPONSE_UPLOAD_READY if length == 3 => Ok(Response::UploadReady {
            upload_id: fixed_bytes(decoder.bytes()?)?,
            offset: decoder.u64()?,
        }),
        RESPONSE_CHUNK_ACCEPTED if length == 2 => Ok(Response::ChunkAccepted {
            offset: decoder.u64()?,
        }),
        RESPONSE_UPLOAD_COMMITTED if length == 2 => Ok(Response::UploadCommitted {
            blob_id: fixed_bytes(decoder.bytes()?)?,
        }),
        RESPONSE_BLOB_CHUNK if length == 5 => Ok(Response::BlobChunk {
            offset: decoder.u64()?,
            total_size: decoder.u64()?,
            complete: decoder.bool()?,
            chunk: bounded_bytes(decoder, MAX_CHUNK_BYTES)?,
        }),
        RESPONSE_COMMIT_STORED if length == 3 => Ok(Response::CommitStored {
            commit_id: fixed_bytes(decoder.bytes()?)?,
            heads: decode_fixed_array(decoder, MAX_HEADS)?,
        }),
        RESPONSE_COMMIT_RECORD if length == 2 => Ok(Response::CommitRecord {
            signed_commit: bounded_bytes(decoder, MAX_SIGNED_COMMIT_BYTES)?,
        }),
        RESPONSE_HEADS if length == 2 => {
            Ok(Response::Heads(decode_fixed_array(decoder, MAX_HEADS)?))
        }
        RESPONSE_CHANGES if length == 3 => {
            let count = definite_array(decoder)?;
            if count > MAX_CHANGES_PER_RESPONSE {
                return Err(CodecError::LimitExceeded);
            }
            let mut commits = Vec::with_capacity(count);
            for _ in 0..count {
                commits.push(bounded_bytes(decoder, MAX_SIGNED_COMMIT_BYTES)?);
            }
            Ok(Response::Changes {
                commits,
                has_more: decoder.bool()?,
            })
        }
        RESPONSE_PONG if length == 1 => Ok(Response::Pong),
        RESPONSE_ERROR if length == 2 => Ok(Response::Error(
            ErrorCode::try_from(decoder.u16()?).map_err(|()| CodecError::UnsupportedValue)?,
        )),
        _ => Err(CodecError::UnsupportedValue),
    }
}

fn encode_optional_bytes<W: encode::Write>(
    encoder: &mut Encoder<W>,
    value: Option<&[u8]>,
) -> Result<(), encode::Error<W::Error>> {
    if let Some(bytes) = value {
        encoder.bytes(bytes)?;
    } else {
        encoder.null()?;
    }
    Ok(())
}

fn encode_fixed_array<W: encode::Write, const N: usize>(
    encoder: &mut Encoder<W>,
    values: &[[u8; N]],
) -> Result<(), encode::Error<W::Error>> {
    encoder.array(values.len() as u64)?;
    for value in values {
        encoder.bytes(value)?;
    }
    Ok(())
}

fn decode_fixed_array<const N: usize>(
    decoder: &mut Decoder<'_>,
    maximum: usize,
) -> Result<Vec<[u8; N]>, CodecError> {
    let count = definite_array(decoder)?;
    if count > maximum {
        return Err(CodecError::LimitExceeded);
    }
    let mut values = Vec::with_capacity(count);
    for _ in 0..count {
        values.push(fixed_bytes(decoder.bytes()?)?);
    }
    Ok(values)
}

fn decode_optional_fixed<const N: usize>(
    decoder: &mut Decoder<'_>,
) -> Result<Option<[u8; N]>, CodecError> {
    if decoder.datatype()? == minicbor::data::Type::Null {
        decoder.null()?;
        Ok(None)
    } else {
        fixed_bytes(decoder.bytes()?).map(Some)
    }
}

fn bounded_bytes(decoder: &mut Decoder<'_>, maximum: usize) -> Result<Vec<u8>, CodecError> {
    let value = decoder.bytes()?;
    if value.len() > maximum {
        return Err(CodecError::LimitExceeded);
    }
    Ok(value.to_vec())
}

fn fixed_bytes<const N: usize>(value: &[u8]) -> Result<[u8; N], CodecError> {
    value.try_into().map_err(|_| CodecError::InvalidByteLength)
}

fn definite_array(decoder: &mut Decoder<'_>) -> Result<usize, CodecError> {
    let length = decoder.array()?.ok_or(CodecError::NonDeterministic)?;
    usize::try_from(length).map_err(|_| CodecError::LimitExceeded)
}

fn expect_array(decoder: &mut Decoder<'_>, expected: usize) -> Result<(), CodecError> {
    if definite_array(decoder)? != expected {
        return Err(CodecError::UnsupportedValue);
    }
    Ok(())
}

fn finish(decoder: &Decoder<'_>, input: &[u8]) -> Result<(), CodecError> {
    if decoder.position() != input.len() {
        return Err(CodecError::NonDeterministic);
    }
    Ok(())
}

fn ensure_deterministic(input: &[u8], encoded: &[u8]) -> Result<(), CodecError> {
    if input != encoded {
        return Err(CodecError::NonDeterministic);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        decode_auth_challenge, decode_bootstrap, decode_client_message, decode_server_message,
        encode_auth_challenge, encode_bootstrap, encode_client_message, encode_server_message,
    };
    use crate::{
        AuthChallenge, Bootstrap, ClientMessage, DeviceRecord, ErrorCode, MAX_HANDSHAKE_BYTES,
        MAX_TRANSPORT_CIPHERTEXT_BYTES, NOISE_SUITE, PROTOCOL_VERSION, Request, Response,
        ServerMessage,
    };

    #[test]
    fn bootstrap_round_trips() {
        let value = Bootstrap {
            protocol_version: PROTOCOL_VERSION,
            instance_id: [1; 16],
            noise_suite: NOISE_SUITE.to_owned(),
            server_static_public_key: [2; 32],
            server_fingerprint: "SHA256:TEST".to_owned(),
            maximum_handshake_bytes: u32::try_from(MAX_HANDSHAKE_BYTES).unwrap(),
            maximum_transport_bytes: u32::try_from(MAX_TRANSPORT_CIPHERTEXT_BYTES).unwrap(),
        };
        let encoded = encode_bootstrap(&value).unwrap();
        assert_eq!(decode_bootstrap(&encoded).unwrap(), value);
    }

    #[test]
    fn challenge_round_trips() {
        let value = AuthChallenge {
            session_handle: [1; 32],
            authentication_salt: [2; 16],
            argon2_memory_kib: 65_536,
            argon2_iterations: 3,
            argon2_parallelism: 1,
            random_challenge: [3; 32],
            session_id: [4; 16],
        };
        let encoded = encode_auth_challenge(&value).unwrap();
        assert_eq!(decode_auth_challenge(&encoded).unwrap(), value);
    }

    #[test]
    fn requests_round_trip() {
        let requests = [
            Request::Authenticate {
                proof: [1; 32],
                device_id: None,
                device_signature: None,
            },
            Request::RegisterDevice {
                device_id: [2; 16],
                public_key: [3; 32],
                encrypted_name: vec![4, 5],
                signature: [6; 64],
            },
            Request::BeginUpload {
                expected_size: 42,
                expected_hash: [7; 32],
            },
            Request::UploadChunk {
                upload_id: [8; 16],
                offset: 4,
                chunk: vec![9, 10],
            },
            Request::GetBlob {
                blob_id: [11; 32],
                offset: 12,
                maximum_bytes: 13,
            },
            Request::PutCommit {
                signed_commit: vec![14, 15],
            },
            Request::GetChanges {
                known_commit_ids: vec![[16; 32]],
                maximum_commits: 2,
            },
        ];
        for request in requests {
            let value = ClientMessage {
                sequence: 9,
                request,
            };
            let encoded = encode_client_message(&value).unwrap();
            assert_eq!(decode_client_message(&encoded).unwrap(), value);
        }
    }

    #[test]
    fn responses_round_trip() {
        let responses = [
            Response::Devices(vec![DeviceRecord {
                device_id: [1; 16],
                public_key: [2; 32],
                encrypted_name: vec![3],
                revoked: false,
            }]),
            Response::BlobChunk {
                offset: 1,
                total_size: 2,
                complete: true,
                chunk: vec![3, 4],
            },
            Response::Error(ErrorCode::IntegrityFailure),
            Response::CommitStored {
                commit_id: [5; 32],
                heads: vec![[6; 32]],
            },
            Response::Changes {
                commits: vec![vec![7, 8]],
                has_more: true,
            },
        ];
        for response in responses {
            let value = ServerMessage {
                sequence: 4,
                response,
            };
            let encoded = encode_server_message(&value).unwrap();
            assert_eq!(decode_server_message(&encoded).unwrap(), value);
        }
    }

    #[test]
    fn trailing_bytes_are_rejected() {
        let value = ClientMessage {
            sequence: 0,
            request: Request::Ping,
        };
        let mut encoded = encode_client_message(&value).unwrap();
        encoded.push(0);
        assert!(decode_client_message(&encoded).is_err());
    }
}
