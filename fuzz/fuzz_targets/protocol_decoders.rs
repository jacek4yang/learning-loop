#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = ll_protocol::decode_transport_frame(data);
    let _ = ll_protocol::decode_bootstrap(data);
    let _ = ll_protocol::decode_auth_challenge(data);
    let _ = ll_protocol::decode_client_message(data);
    let _ = ll_protocol::decode_server_message(data);
});
