use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::VersioningError;

#[derive(Clone)]
struct Node {
    parents: Vec<[u8; 32]>,
    generation: u64,
}

/// Deterministic client-side commit graph index.
#[derive(Clone, Default)]
pub struct CommitGraph {
    nodes: BTreeMap<[u8; 32], Node>,
    heads: BTreeSet<[u8; 32]>,
}

impl CommitGraph {
    /// Inserts one commit metadata record after all parents.
    ///
    /// An exact duplicate is idempotent. A second root, missing parent, or
    /// identifier collision is rejected.
    ///
    /// # Errors
    ///
    /// Returns a [`VersioningError`] for graph-integrity violations.
    pub fn insert(
        &mut self,
        commit_id: [u8; 32],
        parents: Vec<[u8; 32]>,
    ) -> Result<bool, VersioningError> {
        if let Some(existing) = self.nodes.get(&commit_id) {
            return if existing.parents == parents {
                Ok(false)
            } else {
                Err(VersioningError::CommitCollision)
            };
        }
        if parents.is_empty() && !self.nodes.is_empty() {
            return Err(VersioningError::InvalidRoot);
        }
        if !parents.windows(2).all(|pair| pair[0] < pair[1]) {
            return Err(VersioningError::InvalidFormat);
        }
        let generation = if parents.is_empty() {
            0
        } else {
            parents
                .iter()
                .map(|parent| {
                    self.nodes
                        .get(parent)
                        .map(|node| node.generation)
                        .ok_or(VersioningError::MissingParent)
                })
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .max()
                .unwrap_or(0)
                .checked_add(1)
                .ok_or(VersioningError::LimitExceeded)?
        };
        for parent in &parents {
            self.heads.remove(parent);
        }
        self.nodes.insert(
            commit_id,
            Node {
                parents,
                generation,
            },
        );
        self.heads.insert(commit_id);
        Ok(true)
    }

    /// Returns the current lexicographically sorted heads.
    #[must_use]
    pub fn heads(&self) -> Vec<[u8; 32]> {
        self.heads.iter().copied().collect()
    }

    /// Recomputes heads solely from immutable parent relationships.
    #[must_use]
    pub fn recovered_heads(&self) -> Vec<[u8; 32]> {
        let parents: BTreeSet<_> = self
            .nodes
            .values()
            .flat_map(|node| node.parents.iter().copied())
            .collect();
        self.nodes
            .keys()
            .filter(|commit| !parents.contains(*commit))
            .copied()
            .collect()
    }

    /// Finds the highest-generation common ancestor, breaking ties by ID.
    ///
    /// # Errors
    ///
    /// Returns [`VersioningError::CommitNotFound`] when either input is absent.
    pub fn common_ancestor(
        &self,
        left: &[u8; 32],
        right: &[u8; 32],
    ) -> Result<Option<[u8; 32]>, VersioningError> {
        if !self.nodes.contains_key(left) || !self.nodes.contains_key(right) {
            return Err(VersioningError::CommitNotFound);
        }
        let left_ancestors = self.ancestors(left);
        let right_ancestors = self.ancestors(right);
        Ok(left_ancestors
            .intersection(&right_ancestors)
            .max_by_key(|commit| {
                (
                    self.nodes.get(*commit).map_or(0, |node| node.generation),
                    *commit,
                )
            })
            .copied())
    }

    /// Returns parents-before-children IDs absent from `known`.
    #[must_use]
    pub fn missing_from(&self, known: &BTreeSet<[u8; 32]>) -> Vec<[u8; 32]> {
        let mut missing: Vec<_> = self
            .nodes
            .keys()
            .filter(|commit| !known.contains(*commit))
            .copied()
            .collect();
        missing.sort_by_key(|commit| {
            (
                self.nodes.get(commit).map_or(0, |node| node.generation),
                *commit,
            )
        });
        missing
    }

    fn ancestors(&self, start: &[u8; 32]) -> BTreeSet<[u8; 32]> {
        let mut found = BTreeSet::new();
        let mut pending = VecDeque::from([*start]);
        while let Some(commit) = pending.pop_front() {
            if found.insert(commit)
                && let Some(node) = self.nodes.get(&commit)
            {
                pending.extend(node.parents.iter().copied());
            }
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::CommitGraph;

    fn id(value: u8) -> [u8; 32] {
        [value; 32]
    }

    #[test]
    fn concurrent_heads_merge_and_recover_deterministically() {
        let mut graph = CommitGraph::default();
        graph.insert(id(1), vec![]).unwrap();
        graph.insert(id(2), vec![id(1)]).unwrap();
        graph.insert(id(3), vec![id(1)]).unwrap();
        graph.insert(id(4), vec![id(1)]).unwrap();
        assert_eq!(graph.heads(), vec![id(2), id(3), id(4)]);
        assert_eq!(graph.common_ancestor(&id(2), &id(3)).unwrap(), Some(id(1)));
        graph.insert(id(5), vec![id(2), id(3), id(4)]).unwrap();
        assert_eq!(graph.heads(), vec![id(5)]);
        assert_eq!(graph.recovered_heads(), graph.heads());
        assert!(!graph.insert(id(5), vec![id(2), id(3), id(4)]).unwrap());
    }

    #[test]
    fn out_of_order_and_second_root_are_rejected() {
        let mut graph = CommitGraph::default();
        assert!(graph.insert(id(2), vec![id(1)]).is_err());
        graph.insert(id(1), vec![]).unwrap();
        assert!(graph.insert(id(9), vec![]).is_err());
    }

    #[test]
    fn missing_set_is_stable() {
        let mut graph = CommitGraph::default();
        graph.insert(id(1), vec![]).unwrap();
        graph.insert(id(2), vec![id(1)]).unwrap();
        graph.insert(id(3), vec![id(2)]).unwrap();
        assert_eq!(
            graph.missing_from(&BTreeSet::from([id(1)])),
            vec![id(2), id(3)]
        );

        let mut non_lexical = CommitGraph::default();
        non_lexical.insert(id(9), vec![]).unwrap();
        non_lexical.insert(id(1), vec![id(9)]).unwrap();
        assert_eq!(
            non_lexical.missing_from(&BTreeSet::new()),
            vec![id(9), id(1)]
        );
    }
}
