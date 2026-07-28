#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = ll_versioning::decode_signed_commit(data);
    let _ = ll_versioning::decode_commit_body(data);
    let _ = ll_versioning::decode_manifest(data);
});
