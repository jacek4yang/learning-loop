use std::str::Utf8Error;

use thiserror::Error;

/// A canonical text decoding failure.
#[derive(Debug, Error)]
pub enum ContentError {
    /// Synchronized text must be valid UTF-8.
    #[error("text is not valid UTF-8")]
    InvalidUtf8(#[from] Utf8Error),
}

/// Canonicalizes synchronized text without reformatting user content.
///
/// The function removes one leading UTF-8 BOM and maps CRLF or CR line endings
/// to LF. Every other Unicode scalar and trailing newline is preserved.
///
/// # Errors
///
/// Returns [`ContentError::InvalidUtf8`] when `input` is not valid UTF-8.
pub fn canonicalize_text(input: &[u8]) -> Result<Vec<u8>, ContentError> {
    let decoded = std::str::from_utf8(input)?;
    let decoded = decoded.strip_prefix('\u{feff}').unwrap_or(decoded);
    let mut canonical = String::with_capacity(decoded.len());
    let mut characters = decoded.chars().peekable();

    while let Some(character) = characters.next() {
        if character == '\r' {
            if characters.peek() == Some(&'\n') {
                characters.next();
            }
            canonical.push('\n');
        } else {
            canonical.push(character);
        }
    }

    Ok(canonical.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::canonicalize_text;

    #[test]
    fn removes_bom_and_normalizes_mixed_newlines() {
        let actual = canonicalize_text(b"\xef\xbb\xbfone\r\ntwo\rthree\n").unwrap();
        assert_eq!(actual, b"one\ntwo\nthree\n");
    }

    #[test]
    fn preserves_no_final_newline() {
        let actual = canonicalize_text(b"content").unwrap();
        assert_eq!(actual, b"content");
    }

    #[test]
    fn rejects_invalid_utf8() {
        assert!(canonicalize_text(&[0xff]).is_err());
    }
}
