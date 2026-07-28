/// Generates a time-sortable `UUIDv7` stable object identifier.
///
/// The identifier is random with respect to note content and path. It remains
/// attached to the logical object across rename operations.
#[must_use]
pub fn new_object_id() -> [u8; 16] {
    *uuid::Uuid::now_v7().as_bytes()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::new_object_id;

    #[test]
    fn object_ids_are_unique_uuid_v7_values() {
        let ids: BTreeSet<_> = (0..10_000).map(|_| new_object_id()).collect();
        assert_eq!(ids.len(), 10_000);
        assert!(
            ids.iter()
                .all(|id| uuid::Uuid::from_bytes(*id).get_version_num() == 7)
        );
    }
}
