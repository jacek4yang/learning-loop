use ll_canonical::{PortablePath, canonicalize_text};
use proptest::prelude::*;

proptest! {
    #[test]
    fn text_canonicalization_is_idempotent(value in "\\PC{0,2048}") {
        let once = canonicalize_text(value.as_bytes()).unwrap();
        let twice = canonicalize_text(&once).unwrap();
        prop_assert_eq!(once, twice);
    }

    #[test]
    fn accepted_paths_are_idempotent(segments in prop::collection::vec("[a-zA-Z0-9 _-]{1,24}", 1..8)) {
        let candidate = segments.join("/");
        if let Ok(path) = PortablePath::parse(&candidate) {
            let reparsed = PortablePath::parse(path.as_str()).unwrap();
            prop_assert_eq!(path, reparsed);
        }
    }
}
