use std::collections::BTreeMap;
use std::fmt;

use thiserror::Error;
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;

/// Maximum UTF-8 byte length of one path segment.
pub const MAX_SEGMENT_BYTES: usize = 255;

/// Maximum UTF-8 byte length of a complete logical path.
pub const MAX_PATH_BYTES: usize = 1024;

const FORBIDDEN_CHARACTERS: [char; 9] = ['<', '>', ':', '"', '\\', '|', '?', '*', '\0'];

/// A validated, NFC-normalized, relative logical path.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct PortablePath(String);

impl PortablePath {
    /// Parses and canonicalizes a portable logical path.
    ///
    /// Unicode path segments are converted to NFC. No other repair or silent
    /// rename is performed.
    ///
    /// # Errors
    ///
    /// Returns a [`PathError`] when the input is absolute, empty, contains a
    /// forbidden segment or character, uses a reserved Windows device name, or
    /// exceeds a conservative length limit.
    pub fn parse(input: &str) -> Result<Self, PathError> {
        if input.is_empty() {
            return Err(PathError::EmptyPath);
        }
        if input.starts_with('/') {
            return Err(PathError::AbsolutePath);
        }

        let mut segments = Vec::new();
        for segment in input.split('/') {
            if segment.is_empty() {
                return Err(PathError::EmptySegment);
            }
            if segment == "." || segment == ".." {
                return Err(PathError::DotSegment {
                    segment: segment.to_owned(),
                });
            }

            let normalized: String = segment.nfc().collect();
            validate_segment(&normalized)?;
            segments.push(normalized);
        }

        let canonical = segments.join("/");
        if canonical.len() > MAX_PATH_BYTES {
            return Err(PathError::PathTooLong {
                bytes: canonical.len(),
                maximum: MAX_PATH_BYTES,
            });
        }

        Ok(Self(canonical))
    }

    /// Returns the canonical relative path.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Returns the comparison-only, locale-independent portable collision key.
    #[must_use]
    pub fn collision_key(&self) -> String {
        self.0
            .split('/')
            .map(|segment| {
                let folded: String = segment.case_fold().collect();
                folded.nfc().collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("/")
    }
}

impl fmt::Display for PortablePath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A portable path validation failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum PathError {
    /// A path must contain at least one segment.
    #[error("path is empty")]
    EmptyPath,
    /// Logical paths are always relative.
    #[error("absolute paths are forbidden")]
    AbsolutePath,
    /// Repeated or trailing separators create an empty segment.
    #[error("path contains an empty segment")]
    EmptySegment,
    /// Dot traversal segments are forbidden.
    #[error("dot path segment is forbidden: {segment}")]
    DotSegment {
        /// The rejected `.` or `..` segment.
        segment: String,
    },
    /// A Unicode control character is not portable.
    #[error("path segment contains a control character")]
    ControlCharacter,
    /// Windows-reserved punctuation and separators are forbidden.
    #[error("path segment contains forbidden character: {character:?}")]
    ForbiddenCharacter {
        /// The rejected character.
        character: char,
    },
    /// Windows strips a trailing ASCII space or period.
    #[error("path segment ends with an ASCII space or period")]
    TrailingSpaceOrDot,
    /// Windows device aliases remain reserved even with extensions.
    #[error("path segment is a reserved Windows device name: {segment}")]
    ReservedName {
        /// The rejected normalized segment.
        segment: String,
    },
    /// A segment exceeds the cross-platform byte limit.
    #[error("path segment is {bytes} bytes; maximum is {maximum}")]
    SegmentTooLong {
        /// Actual UTF-8 byte count.
        bytes: usize,
        /// Allowed UTF-8 byte count.
        maximum: usize,
    },
    /// A complete path exceeds the protocol byte limit.
    #[error("path is {bytes} bytes; maximum is {maximum}")]
    PathTooLong {
        /// Actual UTF-8 byte count.
        bytes: usize,
        /// Allowed UTF-8 byte count.
        maximum: usize,
    },
}

impl PathError {
    /// Returns the stable protocol/test-vector error code.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::EmptyPath => "empty_path",
            Self::AbsolutePath => "absolute_path",
            Self::EmptySegment => "empty_segment",
            Self::DotSegment { .. } => "dot_segment",
            Self::ControlCharacter => "control_character",
            Self::ForbiddenCharacter { .. } => "forbidden_character",
            Self::TrailingSpaceOrDot => "trailing_space_or_dot",
            Self::ReservedName { .. } => "reserved_name",
            Self::SegmentTooLong { .. } => "segment_too_long",
            Self::PathTooLong { .. } => "path_too_long",
        }
    }
}

/// A group of distinct canonical paths that compare equal portably.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PathCollision {
    /// The comparison-only collision key.
    pub key: String,
    /// Canonical logical paths sharing the key, in lexical order.
    pub paths: Vec<PortablePath>,
}

/// Finds portable collisions without changing any path.
#[must_use]
pub fn detect_collisions(paths: impl IntoIterator<Item = PortablePath>) -> Vec<PathCollision> {
    let mut grouped: BTreeMap<String, Vec<PortablePath>> = BTreeMap::new();
    for path in paths {
        grouped.entry(path.collision_key()).or_default().push(path);
    }

    grouped
        .into_iter()
        .filter_map(|(key, mut members)| {
            members.sort();
            (members.len() > 1).then_some(PathCollision {
                key,
                paths: members,
            })
        })
        .collect()
}

/// Suggests a deterministic safe name for one invalid path segment.
///
/// This is only a UI suggestion. Callers must not apply it without explicit
/// user confirmation and a signed rename commit.
#[must_use]
pub fn suggest_safe_segment(input: &str) -> String {
    let normalized: String = input.nfc().collect();
    let mut suggested = String::with_capacity(normalized.len());

    for character in normalized.chars() {
        if character.is_control() || FORBIDDEN_CHARACTERS.contains(&character) {
            suggested.push('_');
        } else {
            suggested.push(character);
        }
    }

    while suggested.ends_with([' ', '.']) {
        suggested.pop();
    }
    if suggested.is_empty() || suggested == "." || suggested == ".." {
        "untitled".clone_into(&mut suggested);
    }
    if is_reserved_name(&suggested) {
        suggested.insert(0, '_');
    }

    while suggested.len() > MAX_SEGMENT_BYTES {
        suggested.pop();
    }
    if suggested.is_empty() {
        "untitled".to_owned()
    } else {
        suggested
    }
}

fn validate_segment(segment: &str) -> Result<(), PathError> {
    for character in segment.chars() {
        if character.is_control() {
            return Err(PathError::ControlCharacter);
        }
        if FORBIDDEN_CHARACTERS.contains(&character) {
            return Err(PathError::ForbiddenCharacter { character });
        }
    }

    if segment.ends_with([' ', '.']) {
        return Err(PathError::TrailingSpaceOrDot);
    }
    if is_reserved_name(segment) {
        return Err(PathError::ReservedName {
            segment: segment.to_owned(),
        });
    }
    if segment.len() > MAX_SEGMENT_BYTES {
        return Err(PathError::SegmentTooLong {
            bytes: segment.len(),
            maximum: MAX_SEGMENT_BYTES,
        });
    }
    Ok(())
}

fn is_reserved_name(segment: &str) -> bool {
    let basename = segment
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();

    matches!(basename.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || is_numbered_device(&basename, "COM")
        || is_numbered_device(&basename, "LPT")
}

fn is_numbered_device(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix)
        .is_some_and(|suffix| matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
}

#[cfg(test)]
mod tests {
    use super::{PortablePath, detect_collisions, suggest_safe_segment};

    #[test]
    fn normalizes_to_nfc() {
        let path = PortablePath::parse("notes/e\u{301}.md").unwrap();
        assert_eq!(path.as_str(), "notes/é.md");
    }

    #[test]
    fn detects_case_and_normalization_collisions() {
        let paths = ["Note.md", "note.md", "e\u{301}.md", "é.md"]
            .into_iter()
            .map(|value| PortablePath::parse(value).unwrap());
        let collisions = detect_collisions(paths);
        assert_eq!(collisions.len(), 2);
    }

    #[test]
    fn suggests_but_does_not_apply_a_safe_name() {
        assert_eq!(suggest_safe_segment("CON.txt"), "_CON.txt");
        assert_eq!(suggest_safe_segment("bad<name. "), "bad_name");
    }
}
