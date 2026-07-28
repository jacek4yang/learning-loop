use ll_crypto::ObjectType;
use ll_versioning::{
    CommitBody, Manifest, ManifestEntry, Operation, OperationKind, encode_commit_body,
    encode_manifest,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::js_error;

#[derive(Deserialize)]
struct ManifestInput {
    vault_id_hex: String,
    entries: Vec<ManifestEntryInput>,
}

#[derive(Deserialize)]
struct ManifestEntryInput {
    object_id_hex: String,
    revision: String,
    object_type: u8,
    encrypted_path_blob_id_hex: String,
    content_blob_id_hex: Option<String>,
    metadata_blob_id_hex: Option<String>,
    canonical_plaintext_hash_hex: String,
    tombstone: bool,
}

#[derive(Deserialize)]
struct CommitBodyInput {
    logical_timestamp: String,
    operations: Vec<OperationInput>,
    manifest_root_hex: String,
    manifest_blob_id_hex: String,
    merge_base_hex: Option<String>,
    conflict_object_ids_hex: Vec<String>,
}

#[derive(Deserialize)]
struct OperationInput {
    kind: u8,
    object_id_hex: String,
    base_revision: String,
    revision: String,
    encrypted_path_blob_id_hex: Option<String>,
    content_blob_id_hex: Option<String>,
}

#[derive(Serialize)]
struct SignedCommitOutput {
    commit_id_hex: String,
    parent_ids_hex: Vec<String>,
    device_id_hex: String,
    device_sequence: String,
    body: CommitBodyOutput,
}

#[derive(Serialize)]
struct CommitBodyOutput {
    logical_timestamp: String,
    operations: Vec<OperationOutput>,
    manifest_root_hex: String,
    manifest_blob_id_hex: String,
    merge_base_hex: Option<String>,
    conflict_object_ids_hex: Vec<String>,
}

#[derive(Serialize)]
struct OperationOutput {
    kind: u8,
    object_id_hex: String,
    base_revision: String,
    revision: String,
    encrypted_path_blob_id_hex: Option<String>,
    content_blob_id_hex: Option<String>,
}

/// Encodes a stable JSON manifest description as deterministic CBOR.
///
/// # Errors
///
/// Returns a safe JavaScript error for malformed JSON, hex, limits, or
/// manifest invariants.
#[wasm_bindgen]
pub fn encode_manifest_json(input: &str) -> Result<Vec<u8>, JsValue> {
    let input: ManifestInput = serde_json::from_str(input).map_err(js_error)?;
    let manifest = Manifest::new(
        decode_hex(&input.vault_id_hex)?,
        input
            .entries
            .into_iter()
            .map(|entry| {
                Ok(ManifestEntry {
                    object_id: decode_hex(&entry.object_id_hex)?,
                    revision: parse_u64(&entry.revision)?,
                    object_type: ObjectType::try_from(entry.object_type).map_err(js_error)?,
                    encrypted_path_blob_id: decode_hex(&entry.encrypted_path_blob_id_hex)?,
                    content_blob_id: decode_optional(entry.content_blob_id_hex)?,
                    metadata_blob_id: decode_optional(entry.metadata_blob_id_hex)?,
                    canonical_plaintext_hash: decode_hex(&entry.canonical_plaintext_hash_hex)?,
                    tombstone: entry.tombstone,
                })
            })
            .collect::<Result<Vec<_>, JsValue>>()?,
    )
    .map_err(js_error)?;
    encode_manifest(&manifest).map_err(js_error)
}

/// Computes the deterministic manifest Merkle root from stable JSON.
///
/// # Errors
///
/// Returns a safe JavaScript error for malformed input or invariants.
#[wasm_bindgen]
pub fn manifest_root_json(input: &str) -> Result<Vec<u8>, JsValue> {
    let encoded = encode_manifest_json(input)?;
    let manifest = ll_versioning::decode_manifest(&encoded).map_err(js_error)?;
    manifest.root().map(Vec::from).map_err(js_error)
}

/// Encodes a stable JSON commit-body description as deterministic CBOR.
///
/// # Errors
///
/// Returns a safe JavaScript error for malformed input or invariants.
#[wasm_bindgen]
pub fn encode_commit_body_json(input: &str) -> Result<Vec<u8>, JsValue> {
    encode_commit_body(&decode_commit_body_input(input)?).map_err(js_error)
}

/// Decodes a deterministic manifest as stable JSON.
///
/// # Errors
///
/// Returns a safe JavaScript error for malformed or non-deterministic input.
#[wasm_bindgen]
pub fn decode_manifest_json(encoded: &[u8]) -> Result<String, JsValue> {
    let manifest = ll_versioning::decode_manifest(encoded).map_err(js_error)?;
    let entries = manifest
        .entries
        .into_iter()
        .map(|entry| {
            serde_json::json!({
                "object_id_hex": hex::encode(entry.object_id),
                "revision": entry.revision.to_string(),
                "object_type": entry.object_type as u8,
                "encrypted_path_blob_id_hex": hex::encode(entry.encrypted_path_blob_id),
                "content_blob_id_hex": entry.content_blob_id.map(hex::encode),
                "metadata_blob_id_hex": entry.metadata_blob_id.map(hex::encode),
                "canonical_plaintext_hash_hex": hex::encode(entry.canonical_plaintext_hash),
                "tombstone": entry.tombstone,
            })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "vault_id_hex": hex::encode(manifest.vault_id),
        "entries": entries,
    })
    .to_string())
}

pub(crate) fn decode_signed_commit_output(
    vault: &ll_client::UnlockedVault,
    encoded: &[u8],
    public_key: &[u8; 32],
) -> Result<String, JsValue> {
    let commit = ll_versioning::decode_signed_commit(encoded).map_err(js_error)?;
    ll_versioning::verify_signed_commit(&commit, public_key).map_err(js_error)?;
    let (_, clear) = vault
        .decrypt(&commit.unsigned.encrypted_body)
        .map_err(js_error)?;
    let body = ll_versioning::decode_commit_body(&clear).map_err(js_error)?;
    let output = SignedCommitOutput {
        commit_id_hex: hex::encode(commit.commit_id),
        parent_ids_hex: commit
            .unsigned
            .parents
            .into_iter()
            .map(hex::encode)
            .collect(),
        device_id_hex: hex::encode(commit.unsigned.device_id),
        device_sequence: commit.unsigned.device_sequence.to_string(),
        body: CommitBodyOutput {
            logical_timestamp: body.logical_timestamp.to_string(),
            operations: body
                .operations
                .into_iter()
                .map(|operation| OperationOutput {
                    kind: operation.kind as u8,
                    object_id_hex: hex::encode(operation.object_id),
                    base_revision: operation.base_revision.to_string(),
                    revision: operation.revision.to_string(),
                    encrypted_path_blob_id_hex: operation.encrypted_path_blob_id.map(hex::encode),
                    content_blob_id_hex: operation.content_blob_id.map(hex::encode),
                })
                .collect(),
            manifest_root_hex: hex::encode(body.manifest_root),
            manifest_blob_id_hex: hex::encode(body.manifest_blob_id),
            merge_base_hex: body.merge_base.map(hex::encode),
            conflict_object_ids_hex: body.conflict_objects.into_iter().map(hex::encode).collect(),
        },
    };
    serde_json::to_string(&output).map_err(js_error)
}

pub(crate) fn decode_commit_body_input(input: &str) -> Result<CommitBody, JsValue> {
    let input: CommitBodyInput = serde_json::from_str(input).map_err(js_error)?;
    Ok(CommitBody {
        logical_timestamp: parse_u64(&input.logical_timestamp)?,
        operations: input
            .operations
            .into_iter()
            .map(|operation| {
                Ok(Operation {
                    kind: OperationKind::try_from(operation.kind).map_err(js_error)?,
                    object_id: decode_hex(&operation.object_id_hex)?,
                    base_revision: parse_u64(&operation.base_revision)?,
                    revision: parse_u64(&operation.revision)?,
                    encrypted_path_blob_id: decode_optional(operation.encrypted_path_blob_id_hex)?,
                    content_blob_id: decode_optional(operation.content_blob_id_hex)?,
                })
            })
            .collect::<Result<Vec<_>, JsValue>>()?,
        manifest_root: decode_hex(&input.manifest_root_hex)?,
        manifest_blob_id: decode_hex(&input.manifest_blob_id_hex)?,
        merge_base: decode_optional(input.merge_base_hex)?,
        conflict_objects: input
            .conflict_object_ids_hex
            .into_iter()
            .map(|value| decode_hex(&value))
            .collect::<Result<Vec<_>, _>>()?,
    })
}

pub(crate) fn parse_parents(input: &[u8]) -> Result<Vec<[u8; 32]>, JsValue> {
    if !input.len().is_multiple_of(32) {
        return Err(JsValue::from_str("parent IDs have invalid length"));
    }
    input
        .chunks_exact(32)
        .map(fixed)
        .collect::<Result<Vec<_>, _>>()
}

pub(crate) fn fixed<const N: usize>(value: &[u8]) -> Result<[u8; N], JsValue> {
    value
        .try_into()
        .map_err(|_| JsValue::from_str("fixed byte field has invalid length"))
}

fn decode_optional<const N: usize>(value: Option<String>) -> Result<Option<[u8; N]>, JsValue> {
    value.map(|hex| decode_hex(&hex)).transpose()
}

fn decode_hex<const N: usize>(value: &str) -> Result<[u8; N], JsValue> {
    hex::decode(value)
        .map_err(js_error)?
        .try_into()
        .map_err(|_| JsValue::from_str("hex field has invalid length"))
}

fn parse_u64(value: &str) -> Result<u64, JsValue> {
    value
        .parse()
        .map_err(|_| JsValue::from_str("invalid unsigned integer"))
}
