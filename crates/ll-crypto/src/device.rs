use ed25519_dalek::{Signature, Verifier, VerifyingKey};

use crate::CryptoError;

const DEVICE_AUTH_LABEL: &[u8] = b"learning-loop/device-auth/v1";
const DEVICE_REGISTRATION_LABEL: &[u8] = b"learning-loop/device-registration/v1";

/// Builds the signed context for an existing registered device.
#[must_use]
pub fn device_auth_signature_context(authentication_context: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(DEVICE_AUTH_LABEL.len() + authentication_context.len());
    output.extend_from_slice(DEVICE_AUTH_LABEL);
    output.extend_from_slice(authentication_context);
    output
}

/// Builds the proof-of-possession context for registration or reauthorization.
#[must_use]
pub fn registration_signature_context(
    authentication_context: &[u8],
    device_id: &[u8; 16],
    public_key: &[u8; 32],
) -> Vec<u8> {
    let mut output = Vec::with_capacity(
        DEVICE_REGISTRATION_LABEL.len() + authentication_context.len() + 16 + 32,
    );
    output.extend_from_slice(DEVICE_REGISTRATION_LABEL);
    output.extend_from_slice(authentication_context);
    output.extend_from_slice(device_id);
    output.extend_from_slice(public_key);
    output
}

/// Verifies an Ed25519 device signature with strict key parsing.
///
/// # Errors
///
/// Returns [`CryptoError::InvalidDeviceSignature`] for an invalid key or
/// signature.
pub fn verify_device_signature(
    public_key: &[u8; 32],
    message: &[u8],
    signature: &[u8; 64],
) -> Result<(), CryptoError> {
    let verifying_key =
        VerifyingKey::from_bytes(public_key).map_err(|_| CryptoError::InvalidDeviceSignature)?;
    let signature = Signature::from_bytes(signature);
    verifying_key
        .verify(message, &signature)
        .map_err(|_| CryptoError::InvalidDeviceSignature)
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer, SigningKey};

    use super::{device_auth_signature_context, verify_device_signature};

    #[test]
    fn forged_device_signature_is_rejected() {
        let legitimate = SigningKey::from_bytes(&crate::random_array::<32>().unwrap());
        let attacker = SigningKey::from_bytes(&crate::random_array::<32>().unwrap());
        let context = device_auth_signature_context(b"runtime challenge context");
        let forged = attacker.sign(&context).to_bytes();
        assert!(
            verify_device_signature(&legitimate.verifying_key().to_bytes(), &context, &forged)
                .is_err()
        );
    }
}
