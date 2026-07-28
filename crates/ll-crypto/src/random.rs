use crate::CryptoError;

/// Returns a fixed-size array filled by the operating system CSPRNG.
///
/// # Errors
///
/// Returns [`CryptoError::Random`] if secure randomness is unavailable.
pub fn random_array<const N: usize>() -> Result<[u8; N], CryptoError> {
    let mut output = [0_u8; N];
    getrandom::fill(&mut output)?;
    Ok(output)
}
