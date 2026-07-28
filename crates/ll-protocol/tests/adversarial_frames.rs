use ll_protocol::{
    FRAME_MAGIC, FrameError, MAX_TRANSPORT_CIPHERTEXT_BYTES, decode_client_message,
    decode_server_message, decode_transport_frame, encode_transport_frame,
};
use proptest::prelude::*;

proptest! {
    #[test]
    fn arbitrary_ciphertext_frames_round_trip(
        handle in any::<[u8; 32]>(),
        ciphertext in prop::collection::vec(any::<u8>(), 0..16_384),
    ) {
        let encoded = encode_transport_frame(&handle, &ciphertext).unwrap();
        let decoded = decode_transport_frame(&encoded).unwrap();
        prop_assert_eq!(decoded.session_handle, handle);
        prop_assert_eq!(decoded.ciphertext, ciphertext);
    }

    #[test]
    fn arbitrary_untrusted_decoders_never_panic(data in prop::collection::vec(any::<u8>(), 0..65_536)) {
        let _ = decode_transport_frame(&data);
        let _ = decode_client_message(&data);
        let _ = decode_server_message(&data);
    }

    #[test]
    fn every_false_declared_length_is_rejected(
        body in prop::collection::vec(any::<u8>(), 0..4096),
        declared in any::<u32>(),
    ) {
        prop_assume!(usize::try_from(declared).ok() != Some(body.len()));
        let mut frame = Vec::with_capacity(40 + body.len());
        frame.extend_from_slice(&FRAME_MAGIC);
        frame.extend_from_slice(&[7_u8; 32]);
        frame.extend_from_slice(&declared.to_be_bytes());
        frame.extend_from_slice(&body);
        prop_assert!(decode_transport_frame(&frame).is_err());
    }
}

#[test]
fn oversized_declared_length_is_rejected_before_body_allocation() {
    let mut frame = Vec::with_capacity(40);
    frame.extend_from_slice(&FRAME_MAGIC);
    frame.extend_from_slice(&[0_u8; 32]);
    frame.extend_from_slice(
        &u32::try_from(MAX_TRANSPORT_CIPHERTEXT_BYTES + 1)
            .unwrap()
            .to_be_bytes(),
    );
    assert!(decode_transport_frame(&frame).is_err());
}

#[test]
fn every_truncated_header_and_the_empty_maximum_frame_hit_exact_boundaries() {
    for length in 0..40 {
        assert_eq!(
            decode_transport_frame(&vec![0_u8; length]),
            Err(FrameError::Truncated)
        );
    }

    let empty = encode_transport_frame(&[1_u8; 32], &[]).unwrap();
    assert!(decode_transport_frame(&empty).is_ok());

    let maximum_ciphertext = vec![0x5a; MAX_TRANSPORT_CIPHERTEXT_BYTES];
    let maximum = encode_transport_frame(&[2_u8; 32], &maximum_ciphertext).unwrap();
    assert!(decode_transport_frame(&maximum).is_ok());
}

#[test]
fn one_byte_over_the_limit_reports_too_large_even_with_a_complete_body() {
    let declared = MAX_TRANSPORT_CIPHERTEXT_BYTES + 1;
    let mut frame = Vec::with_capacity(40 + declared);
    frame.extend_from_slice(&FRAME_MAGIC);
    frame.extend_from_slice(&[0_u8; 32]);
    frame.extend_from_slice(&u32::try_from(declared).unwrap().to_be_bytes());
    frame.resize(40 + declared, 0);
    assert_eq!(decode_transport_frame(&frame), Err(FrameError::TooLarge));
}
