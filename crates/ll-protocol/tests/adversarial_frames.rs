use ll_protocol::{
    FRAME_MAGIC, MAX_TRANSPORT_CIPHERTEXT_BYTES, decode_client_message, decode_server_message,
    decode_transport_frame, encode_transport_frame,
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
