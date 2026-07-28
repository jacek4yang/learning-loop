use thiserror::Error;

use crate::MAX_TRANSPORT_CIPHERTEXT_BYTES;

/// Fixed magic prefix for an HTTP-carried transport frame.
pub const FRAME_MAGIC: [u8; 4] = *b"LLP1";

/// A validated borrowed transport frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TransportFrame<'a> {
    /// Opaque session lookup handle.
    pub session_handle: [u8; 32],
    /// Length-prefixed Noise transport ciphertext record stream.
    pub ciphertext: &'a [u8],
}

/// Transport frame parsing failure.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum FrameError {
    /// Header is truncated.
    #[error("transport frame is truncated")]
    Truncated,
    /// Magic or protocol version is wrong.
    #[error("transport frame magic is invalid")]
    InvalidMagic,
    /// Declared ciphertext length differs from the body.
    #[error("transport frame length is invalid")]
    InvalidLength,
    /// Ciphertext exceeds the hard protocol limit.
    #[error("transport frame is too large")]
    TooLarge,
}

/// Encodes one body-level transport frame containing a Noise record stream.
///
/// # Errors
///
/// Returns [`FrameError::TooLarge`] when `ciphertext` exceeds the hard limit.
pub fn encode_transport_frame(
    session_handle: &[u8; 32],
    ciphertext: &[u8],
) -> Result<Vec<u8>, FrameError> {
    if ciphertext.len() > MAX_TRANSPORT_CIPHERTEXT_BYTES {
        return Err(FrameError::TooLarge);
    }
    let length = u32::try_from(ciphertext.len()).map_err(|_| FrameError::TooLarge)?;
    let mut frame = Vec::with_capacity(40 + ciphertext.len());
    frame.extend_from_slice(&FRAME_MAGIC);
    frame.extend_from_slice(session_handle);
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(ciphertext);
    Ok(frame)
}

/// Parses one body-level transport frame without allocating the ciphertext.
///
/// # Errors
///
/// Returns a [`FrameError`] for invalid magic, truncation, length mismatch, or
/// an oversized ciphertext.
pub fn decode_transport_frame(input: &[u8]) -> Result<TransportFrame<'_>, FrameError> {
    if input.len() < 40 {
        return Err(FrameError::Truncated);
    }
    if input[..4] != FRAME_MAGIC {
        return Err(FrameError::InvalidMagic);
    }
    let mut session_handle = [0_u8; 32];
    session_handle.copy_from_slice(&input[4..36]);
    let declared = u32::from_be_bytes(
        input[36..40]
            .try_into()
            .map_err(|_| FrameError::Truncated)?,
    );
    let declared = usize::try_from(declared).map_err(|_| FrameError::InvalidLength)?;
    if declared > MAX_TRANSPORT_CIPHERTEXT_BYTES {
        return Err(FrameError::TooLarge);
    }
    if input.len() != 40 + declared {
        return Err(FrameError::InvalidLength);
    }
    Ok(TransportFrame {
        session_handle,
        ciphertext: &input[40..],
    })
}

#[cfg(test)]
mod tests {
    use super::{decode_transport_frame, encode_transport_frame};

    #[test]
    fn frame_round_trips() {
        let handle = [7_u8; 32];
        let encoded = encode_transport_frame(&handle, b"ciphertext").unwrap();
        let decoded = decode_transport_frame(&encoded).unwrap();
        assert_eq!(decoded.session_handle, handle);
        assert_eq!(decoded.ciphertext, b"ciphertext");
    }

    #[test]
    fn length_tampering_is_rejected() {
        let mut encoded = encode_transport_frame(&[0_u8; 32], b"x").unwrap();
        encoded[39] = 2;
        assert!(decode_transport_frame(&encoded).is_err());
    }
}
