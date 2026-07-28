use ll_protocol::{
    MAX_HANDSHAKE_BYTES, MAX_TRANSPORT_CIPHERTEXT_BYTES, NOISE_SUITE, encode_noise_prologue,
};

use crate::{CryptoError, ServerIdentity};

const NOISE_TAG_BYTES: usize = 16;
const MAX_NOISE_MESSAGE_BYTES: usize = 65_535;
const TRANSPORT_PLAINTEXT_RECORD_BYTES: usize = 60 * 1024;
const RECORD_LENGTH_BYTES: usize = 2;

/// Successful server-side Noise handshake state.
pub struct AcceptedHandshake {
    /// Final transcript hash used by password and device proofs.
    pub handshake_hash: Vec<u8>,
    /// Split responder transport state.
    pub transport: snow::TransportState,
    /// Responder Noise handshake message.
    pub response: Vec<u8>,
}

/// Accepts one fixed-suite Noise NK initiator message.
///
/// # Errors
///
/// Returns a [`CryptoError`] for invalid transcript encoding, setup, an
/// oversized message, non-empty unexpected initiator payload, or Noise failure.
pub fn accept_handshake(
    identity: &ServerIdentity,
    instance_id: &[u8; 16],
    initiator_message: &[u8],
    response_payload: &[u8],
) -> Result<AcceptedHandshake, CryptoError> {
    if initiator_message.len() > MAX_HANDSHAKE_BYTES
        || response_payload.len() > MAX_HANDSHAKE_BYTES / 2
    {
        return Err(CryptoError::Noise(snow::Error::Input));
    }
    let params = NOISE_SUITE.parse()?;
    let prologue = encode_noise_prologue(instance_id)?;
    let mut responder = snow::Builder::new(params)
        .local_private_key(identity.private_key())?
        .prologue(&prologue)?
        .build_responder()?;
    let mut ignored_payload = [0_u8; MAX_HANDSHAKE_BYTES];
    let payload_length = responder.read_message(initiator_message, &mut ignored_payload)?;
    if payload_length != 0 {
        return Err(CryptoError::Noise(snow::Error::Input));
    }
    let mut response = vec![0_u8; MAX_HANDSHAKE_BYTES];
    let response_length = responder.write_message(response_payload, &mut response)?;
    response.truncate(response_length);
    let handshake_hash = responder.get_handshake_hash().to_vec();
    let transport = responder.into_transport_mode()?;
    Ok(AcceptedHandshake {
        handshake_hash,
        transport,
        response,
    })
}

/// Creates a fixed-suite Noise NK initiator for clients and integration tests.
///
/// # Errors
///
/// Returns a [`CryptoError`] for transcript encoding or Noise setup failure.
pub fn build_initiator(
    server_public_key: &[u8; 32],
    instance_id: &[u8; 16],
) -> Result<snow::HandshakeState, CryptoError> {
    let params = NOISE_SUITE.parse()?;
    let prologue = encode_noise_prologue(instance_id)?;
    Ok(snow::Builder::new(params)
        .remote_public_key(server_public_key)?
        .prologue(&prologue)?
        .build_initiator()?)
}

/// Encrypts an application message as one or more bounded Noise records.
///
/// Each record is a big-endian `u16` ciphertext length followed by one Noise
/// transport message. Record framing is needed because Noise messages,
/// including the authentication tag, cannot exceed 65,535 bytes.
///
/// # Errors
///
/// Returns a [`CryptoError`] if Noise encryption fails or the complete record
/// stream exceeds the HTTP transport limit.
pub fn encrypt_transport_records(
    transport: &mut snow::TransportState,
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if plaintext.is_empty() {
        return Err(CryptoError::InvalidTransportRecords);
    }
    let record_count = plaintext.len().div_ceil(TRANSPORT_PLAINTEXT_RECORD_BYTES);
    let overhead = record_count
        .checked_mul(RECORD_LENGTH_BYTES + NOISE_TAG_BYTES)
        .ok_or(CryptoError::InvalidTransportRecords)?;
    let capacity = plaintext
        .len()
        .checked_add(overhead)
        .ok_or(CryptoError::InvalidTransportRecords)?;
    if capacity > MAX_TRANSPORT_CIPHERTEXT_BYTES {
        return Err(CryptoError::InvalidTransportRecords);
    }

    let mut records = Vec::with_capacity(capacity);
    for chunk in plaintext.chunks(TRANSPORT_PLAINTEXT_RECORD_BYTES) {
        let mut encrypted = vec![0_u8; chunk.len() + NOISE_TAG_BYTES];
        let written = transport.write_message(chunk, &mut encrypted)?;
        encrypted.truncate(written);
        let length = u16::try_from(written).map_err(|_| CryptoError::InvalidTransportRecords)?;
        records.extend_from_slice(&length.to_be_bytes());
        records.extend_from_slice(&encrypted);
    }
    Ok(records)
}

/// Decrypts and concatenates a bounded stream of length-prefixed Noise records.
///
/// # Errors
///
/// Returns a [`CryptoError`] for truncation, empty/oversized records, excessive
/// aggregate size, or Noise authentication failure.
pub fn decrypt_transport_records(
    transport: &mut snow::TransportState,
    records: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if records.is_empty() || records.len() > MAX_TRANSPORT_CIPHERTEXT_BYTES {
        return Err(CryptoError::InvalidTransportRecords);
    }
    let mut plaintext = Vec::with_capacity(records.len());
    let mut cursor = 0;
    while cursor < records.len() {
        let length_end = cursor
            .checked_add(RECORD_LENGTH_BYTES)
            .ok_or(CryptoError::InvalidTransportRecords)?;
        let length_bytes = records
            .get(cursor..length_end)
            .ok_or(CryptoError::InvalidTransportRecords)?;
        let length = usize::from(u16::from_be_bytes(
            length_bytes
                .try_into()
                .map_err(|_| CryptoError::InvalidTransportRecords)?,
        ));
        if !(NOISE_TAG_BYTES..=MAX_NOISE_MESSAGE_BYTES).contains(&length) {
            return Err(CryptoError::InvalidTransportRecords);
        }
        let record_end = length_end
            .checked_add(length)
            .ok_or(CryptoError::InvalidTransportRecords)?;
        let record = records
            .get(length_end..record_end)
            .ok_or(CryptoError::InvalidTransportRecords)?;
        let mut clear = vec![0_u8; length - NOISE_TAG_BYTES];
        let written = transport.read_message(record, &mut clear)?;
        clear.truncate(written);
        plaintext.extend_from_slice(&clear);
        if plaintext.len() > MAX_TRANSPORT_CIPHERTEXT_BYTES {
            return Err(CryptoError::InvalidTransportRecords);
        }
        cursor = record_end;
    }
    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::{
        accept_handshake, build_initiator, decrypt_transport_records, encrypt_transport_records,
    };
    use crate::ServerIdentity;

    #[test]
    fn fixed_suite_round_trips_handshake_and_transport() {
        let directory = tempfile::tempdir().unwrap();
        let identity = ServerIdentity::load_or_create(directory.path()).unwrap();
        let instance = [9_u8; 16];
        let mut initiator = build_initiator(identity.public_key(), &instance).unwrap();
        let mut first = [0_u8; 4096];
        let first_length = initiator.write_message(&[], &mut first).unwrap();
        let accepted =
            accept_handshake(&identity, &instance, &first[..first_length], b"challenge").unwrap();

        let mut payload = [0_u8; 4096];
        let payload_length = initiator
            .read_message(&accepted.response, &mut payload)
            .unwrap();
        assert_eq!(&payload[..payload_length], b"challenge");
        assert_eq!(
            initiator.get_handshake_hash(),
            accepted.handshake_hash.as_slice()
        );

        let mut client_transport = initiator.into_transport_mode().unwrap();
        let mut encrypted = [0_u8; 128];
        let encrypted_length = client_transport
            .write_message(b"ping", &mut encrypted)
            .unwrap();
        let mut server_transport = accepted.transport;
        let mut clear = [0_u8; 128];
        let clear_length = server_transport
            .read_message(&encrypted[..encrypted_length], &mut clear)
            .unwrap();
        assert_eq!(&clear[..clear_length], b"ping");
    }

    #[test]
    fn transport_record_stream_round_trips_large_application_message() {
        let directory = tempfile::tempdir().unwrap();
        let identity = ServerIdentity::load_or_create(directory.path()).unwrap();
        let instance = [8_u8; 16];
        let mut initiator = build_initiator(identity.public_key(), &instance).unwrap();
        let mut first = [0_u8; 4096];
        let first_length = initiator.write_message(&[], &mut first).unwrap();
        let accepted =
            accept_handshake(&identity, &instance, &first[..first_length], b"challenge").unwrap();
        let mut payload = [0_u8; 4096];
        initiator
            .read_message(&accepted.response, &mut payload)
            .unwrap();
        let mut client_transport = initiator.into_transport_mode().unwrap();
        let mut server_transport = accepted.transport;

        let clear = vec![0x5a; 256 * 1024];
        let records = encrypt_transport_records(&mut client_transport, &clear).unwrap();
        assert!(!records.windows(64).any(|window| window == &clear[..64]));
        assert_eq!(
            decrypt_transport_records(&mut server_transport, &records).unwrap(),
            clear
        );
    }
}
