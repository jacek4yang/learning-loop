//! Cross-platform path and text canonicalization.
//!
//! This crate is the sole authority for values that must compare identically on
//! Windows, macOS, Linux, Android, and the WebAssembly client.

mod content;
mod path;

pub use content::{ContentError, canonicalize_text};
pub use path::{PathCollision, PathError, PortablePath, detect_collisions, suggest_safe_segment};
