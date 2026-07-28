//! Deterministic encrypted commit records, manifests, and client-side DAG
//! algorithms. This is an independent format and does not use Git.

mod commit;
mod error;
mod graph;
mod identity;
mod manifest;

pub use commit::{
    MAX_COMMIT_BODY_BYTES, MAX_COMMIT_PARENTS, MAX_SIGNED_COMMIT_BYTES, SignedCommit,
    UnsignedCommit, commit_signature_context, decode_signed_commit, encode_signed_commit,
    verify_signed_commit,
};
pub use error::VersioningError;
pub use graph::CommitGraph;
pub use identity::new_object_id;
pub use manifest::{
    CommitBody, Manifest, ManifestEntry, Operation, OperationKind, decode_commit_body,
    decode_manifest, encode_commit_body, encode_manifest,
};
