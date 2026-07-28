//! WebAssembly boundary for the portable Learning Loop client core.

use ll_canonical::{PortablePath, canonicalize_text};
use wasm_bindgen::prelude::*;

mod formats;
mod transport;
mod vault;

pub use transport::{WasmClientChannel, WasmResponse};
pub use vault::{WasmDeviceIdentity, WasmVault};

pub(crate) fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

/// Canonicalizes and validates one portable logical path.
///
/// # Errors
///
/// Returns a JavaScript error string with a stable code when validation fails.
#[wasm_bindgen]
pub fn canonicalize_path(input: &str) -> Result<String, JsValue> {
    PortablePath::parse(input)
        .map(|path| path.to_string())
        .map_err(|error| JsValue::from_str(error.code()))
}

/// Produces the comparison-only portable collision key for one valid path.
///
/// # Errors
///
/// Returns a JavaScript error string with a stable code when validation fails.
#[wasm_bindgen]
pub fn portable_collision_key(input: &str) -> Result<String, JsValue> {
    PortablePath::parse(input)
        .map(|path| path.collision_key())
        .map_err(|error| JsValue::from_str(error.code()))
}

/// Canonicalizes UTF-8 text by removing a leading BOM and mapping newlines.
///
/// # Errors
///
/// Returns `invalid_utf8` when the byte slice is not valid UTF-8.
#[wasm_bindgen]
pub fn canonicalize_text_bytes(input: &[u8]) -> Result<Vec<u8>, JsValue> {
    canonicalize_text(input).map_err(|_| JsValue::from_str("invalid_utf8"))
}

/// Computes BLAKE3 over exact bytes for canonical hashes and ciphertext IDs.
#[must_use]
#[wasm_bindgen]
pub fn blake3_hash_bytes(input: &[u8]) -> Vec<u8> {
    blake3::hash(input).as_bytes().to_vec()
}

/// Generates a random `UUIDv7` stable object identifier.
#[must_use]
#[wasm_bindgen]
pub fn new_object_id_bytes() -> Vec<u8> {
    ll_versioning::new_object_id().to_vec()
}
