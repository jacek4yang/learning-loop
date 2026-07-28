#![no_main]

use libfuzzer_sys::fuzz_target;
use zeroize::Zeroizing;

fuzz_target!(|data: &[u8]| {
    let _ = ll_crypto::decode_vault_key_envelope(data);
    let Ok(envelope) = ll_crypto::decode_object_envelope(data) else {
        return;
    };
    let master = ll_crypto::VaultMasterKey::from_recovery_bytes(Zeroizing::new([0x5a; 32]));
    let Ok(subkeys) = master.derive_subkeys(&envelope.vault_id) else {
        return;
    };
    if let Ok((_, plaintext)) = ll_crypto::decrypt_object(&subkeys, data) {
        let _ = ll_versioning::decode_manifest(&plaintext);
        let _ = ll_versioning::decode_commit_body(&plaintext);
    }
});
