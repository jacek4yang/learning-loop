use ll_canonical::{PortablePath, detect_collisions};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Vectors {
    valid: Vec<ValidVector>,
    invalid: Vec<InvalidVector>,
    collision_groups: Vec<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct ValidVector {
    input: String,
    canonical: String,
    collision_key: String,
}

#[derive(Debug, Deserialize)]
struct InvalidVector {
    input: String,
    error: String,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!(
        "../../../protocol/test-vectors/portable-paths.json"
    ))
    .expect("portable path vectors must be valid JSON")
}

#[test]
fn valid_vectors_are_canonical_and_stable() {
    for vector in vectors().valid {
        let parsed = PortablePath::parse(&vector.input).unwrap();
        assert_eq!(parsed.as_str(), vector.canonical);
        assert_eq!(parsed.collision_key(), vector.collision_key);
        assert_eq!(
            PortablePath::parse(parsed.as_str()).unwrap(),
            parsed,
            "canonicalization must be idempotent"
        );
    }
}

#[test]
fn invalid_vectors_fail_with_stable_codes() {
    for vector in vectors().invalid {
        let error = PortablePath::parse(&vector.input).unwrap_err();
        assert_eq!(error.code(), vector.error);
    }
}

#[test]
fn collision_vectors_are_detected() {
    for group in vectors().collision_groups {
        let paths = group
            .iter()
            .map(|value| PortablePath::parse(value).unwrap())
            .collect::<Vec<_>>();
        let collisions = detect_collisions(paths);
        assert_eq!(collisions.len(), 1, "expected one collision for {group:?}");
    }
}
