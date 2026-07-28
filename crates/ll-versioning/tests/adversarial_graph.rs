use std::collections::BTreeSet;

use ll_versioning::{CommitGraph, VersioningError};
use proptest::prelude::*;

fn id(value: u16) -> [u8; 32] {
    let mut output = [0_u8; 32];
    output[..2].copy_from_slice(&value.to_be_bytes());
    output
}

#[test]
fn continuous_two_device_and_three_device_histories_converge() {
    let mut continuous = CommitGraph::default();
    continuous.insert(id(1), vec![]).unwrap();
    continuous.insert(id(2), vec![id(1)]).unwrap();
    continuous.insert(id(3), vec![id(2)]).unwrap();
    assert_eq!(continuous.heads(), vec![id(3)]);

    let mut two_devices = CommitGraph::default();
    two_devices.insert(id(1), vec![]).unwrap();
    two_devices.insert(id(2), vec![id(1)]).unwrap();
    two_devices.insert(id(3), vec![id(1)]).unwrap();
    assert_eq!(two_devices.heads(), vec![id(2), id(3)]);
    assert_eq!(
        two_devices.common_ancestor(&id(2), &id(3)).unwrap(),
        Some(id(1))
    );
    two_devices.insert(id(4), vec![id(2), id(3)]).unwrap();
    assert_eq!(two_devices.heads(), vec![id(4)]);

    let mut three_devices = CommitGraph::default();
    three_devices.insert(id(1), vec![]).unwrap();
    for child in 2..=4 {
        three_devices.insert(id(child), vec![id(1)]).unwrap();
    }
    assert_eq!(three_devices.heads(), vec![id(2), id(3), id(4)]);
    three_devices
        .insert(id(5), vec![id(2), id(3), id(4)])
        .unwrap();
    assert_eq!(three_devices.heads(), vec![id(5)]);
    assert_eq!(three_devices.recovered_heads(), three_devices.heads());
}

#[test]
fn criss_cross_history_chooses_the_highest_stable_common_ancestor() {
    let mut graph = CommitGraph::default();
    graph.insert(id(1), vec![]).unwrap();
    graph.insert(id(2), vec![id(1)]).unwrap();
    graph.insert(id(3), vec![id(1)]).unwrap();
    graph.insert(id(4), vec![id(2), id(3)]).unwrap();
    graph.insert(id(5), vec![id(2), id(3)]).unwrap();
    graph.insert(id(6), vec![id(4)]).unwrap();
    graph.insert(id(7), vec![id(5)]).unwrap();

    assert_eq!(
        graph.common_ancestor(&id(6), &id(7)).unwrap(),
        Some(id(3)),
        "equal-generation ties are resolved by the lexically greatest ID"
    );
}

#[test]
fn duplicates_collisions_missing_parents_and_out_of_order_commits_are_explicit() {
    let mut graph = CommitGraph::default();
    assert!(matches!(
        graph.insert(id(2), vec![id(1)]),
        Err(VersioningError::MissingParent)
    ));
    graph.insert(id(1), vec![]).unwrap();
    assert!(!graph.insert(id(1), vec![]).unwrap());
    assert!(matches!(
        graph.insert(id(1), vec![id(1)]),
        Err(VersioningError::CommitCollision)
    ));
    assert!(matches!(
        graph.insert(id(9), vec![]),
        Err(VersioningError::InvalidRoot)
    ));
    assert!(matches!(
        graph.insert(id(4), vec![id(3), id(2)]),
        Err(VersioningError::InvalidFormat)
    ));
    assert!(matches!(
        graph.insert(id(4), vec![id(1), id(1)]),
        Err(VersioningError::InvalidFormat)
    ));
    assert!(matches!(
        graph.common_ancestor(&id(1), &id(8)),
        Err(VersioningError::CommitNotFound)
    ));
    assert!(matches!(
        graph.common_ancestor(&id(8), &id(1)),
        Err(VersioningError::CommitNotFound)
    ));
}

proptest! {
    #[test]
    fn recovered_heads_and_generation_order_hold_for_arbitrary_forks(
        branch_count in 1_u16..16,
        chain_length in 1_u16..32,
    ) {
        let mut graph = CommitGraph::default();
        graph.insert(id(1), vec![]).unwrap();
        for branch in 0..branch_count {
            graph.insert(id(2 + branch), vec![id(1)]).unwrap();
        }
        let branch_heads = (0..branch_count)
            .map(|branch| id(2 + branch))
            .collect::<Vec<_>>();
        let merge_id = 2 + branch_count;
        graph.insert(id(merge_id), branch_heads).unwrap();

        let mut previous = id(merge_id);
        for offset in 1..chain_length {
            let next = id(merge_id + offset);
            graph.insert(next, vec![previous]).unwrap();
            previous = next;
        }

        prop_assert_eq!(graph.heads(), vec![previous]);
        prop_assert_eq!(graph.recovered_heads(), graph.heads());
        let missing = graph.missing_from(&BTreeSet::from([id(1)]));
        prop_assert_eq!(missing.last(), Some(&previous));
    }
}
