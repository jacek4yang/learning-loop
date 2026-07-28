use minicbor::{Decoder, Encoder};
use subtle::ConstantTimeEq;

use crate::VersioningError;

const MAX_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_MANIFEST_ENTRIES: usize = 100_000;
const MAX_OPERATIONS: usize = 100_000;
const MAX_CONFLICT_OBJECTS: usize = 4096;

/// One stable object mapping in a client-encrypted manifest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManifestEntry {
    /// Stable object identity.
    pub object_id: [u8; 16],
    /// Monotonic object revision.
    pub revision: u64,
    /// Semantic object encryption domain.
    pub object_type: ll_crypto::ObjectType,
    /// Blob containing an encrypted logical path.
    pub encrypted_path_blob_id: [u8; 32],
    /// Content/attachment blob, absent for a tombstone.
    pub content_blob_id: Option<[u8; 32]>,
    /// Optional encrypted Properties/metadata blob.
    pub metadata_blob_id: Option<[u8; 32]>,
    /// Hash of exact canonical plaintext bytes.
    pub canonical_plaintext_hash: [u8; 32],
    /// Explicit deletion marker.
    pub tombstone: bool,
}

/// Complete deterministic client-side manifest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Manifest {
    /// Vault identity.
    pub vault_id: [u8; 16],
    /// Entries in strictly increasing object-ID order.
    pub entries: Vec<ManifestEntry>,
}

impl Manifest {
    /// Sorts entries and rejects duplicate stable object identities.
    ///
    /// # Errors
    ///
    /// Returns a [`VersioningError`] for count, revision, type, or tombstone
    /// invariant violations.
    pub fn new(
        vault_id: [u8; 16],
        mut entries: Vec<ManifestEntry>,
    ) -> Result<Self, VersioningError> {
        entries.sort_by_key(|entry| entry.object_id);
        let manifest = Self { vault_id, entries };
        validate_manifest(&manifest)?;
        Ok(manifest)
    }

    /// Domain-separated Merkle root of the exact deterministic manifest.
    ///
    /// # Errors
    ///
    /// Returns a [`VersioningError`] for invalid fields or encoding.
    pub fn root(&self) -> Result<[u8; 32], VersioningError> {
        let encoded = encode_manifest(self)?;
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"learning-loop/manifest-root/v1");
        hasher.update(&encoded);
        Ok(*hasher.finalize().as_bytes())
    }
}

/// Explicit immutable commit operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum OperationKind {
    /// First revision.
    Create = 1,
    /// Content or metadata changed.
    Modify = 2,
    /// Stable object moved to another encrypted path.
    Rename = 3,
    /// Explicit tombstone.
    DeleteTombstone = 4,
    /// Client-side merge result.
    Merge = 5,
}

impl TryFrom<u8> for OperationKind {
    type Error = VersioningError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Create),
            2 => Ok(Self::Modify),
            3 => Ok(Self::Rename),
            4 => Ok(Self::DeleteTombstone),
            5 => Ok(Self::Merge),
            _ => Err(VersioningError::InvalidFormat),
        }
    }
}

/// One client-only operation inside the encrypted commit body.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Operation {
    /// Operation kind.
    pub kind: OperationKind,
    /// Stable object identity.
    pub object_id: [u8; 16],
    /// Base revision, zero only for create.
    pub base_revision: u64,
    /// Result revision.
    pub revision: u64,
    /// New encrypted path blob when created or renamed.
    pub encrypted_path_blob_id: Option<[u8; 32]>,
    /// New ciphertext content blob when created, modified, or merged.
    pub content_blob_id: Option<[u8; 32]>,
}

/// Client-only deterministic data encrypted as `ObjectType::Commit`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitBody {
    /// Lamport logical time.
    pub logical_timestamp: u64,
    /// Stable deterministic operation order.
    pub operations: Vec<Operation>,
    /// Root of the referenced manifest plaintext.
    pub manifest_root: [u8; 32],
    /// Ciphertext blob holding that manifest.
    pub manifest_blob_id: [u8; 32],
    /// Optional common ancestor used for a merge.
    pub merge_base: Option<[u8; 32]>,
    /// Stable IDs for objects requiring explicit conflict handling.
    pub conflict_objects: Vec<[u8; 16]>,
}

/// Encodes a manifest in exact deterministic CBOR.
///
/// # Errors
///
/// Returns a [`VersioningError`] for invariants, limits, or encoding.
pub fn encode_manifest(manifest: &Manifest) -> Result<Vec<u8>, VersioningError> {
    validate_manifest(manifest)?;
    let mut output = Vec::new();
    let mut encoder = Encoder::new(&mut output);
    encoder
        .map(3)?
        .u8(0)?
        .u16(ll_protocol::PROTOCOL_VERSION)?
        .u8(1)?
        .bytes(&manifest.vault_id)?
        .u8(2)?
        .array(as_u64(manifest.entries.len())?)?;
    for entry in &manifest.entries {
        encoder
            .array(8)?
            .bytes(&entry.object_id)?
            .u64(entry.revision)?
            .u8(entry.object_type as u8)?
            .bytes(&entry.encrypted_path_blob_id)?;
        encode_optional_fixed(&mut encoder, entry.content_blob_id.as_ref())?;
        encode_optional_fixed(&mut encoder, entry.metadata_blob_id.as_ref())?;
        encoder
            .bytes(&entry.canonical_plaintext_hash)?
            .bool(entry.tombstone)?;
    }
    if output.len() > MAX_MANIFEST_BYTES {
        return Err(VersioningError::LimitExceeded);
    }
    Ok(output)
}

/// Decodes and exact-reencodes a bounded manifest.
///
/// # Errors
///
/// Returns a [`VersioningError`] for malformed, non-deterministic, or
/// oversized input.
pub fn decode_manifest(encoded: &[u8]) -> Result<Manifest, VersioningError> {
    if encoded.len() > MAX_MANIFEST_BYTES {
        return Err(VersioningError::LimitExceeded);
    }
    let mut decoder = Decoder::new(encoded);
    expect_map(&mut decoder, 3)?;
    expect_key(&mut decoder, 0)?;
    expect_version(&mut decoder)?;
    expect_key(&mut decoder, 1)?;
    let vault_id = fixed_bytes(decoder.bytes()?)?;
    expect_key(&mut decoder, 2)?;
    let count = definite_array(&mut decoder)?;
    if count > MAX_MANIFEST_ENTRIES {
        return Err(VersioningError::LimitExceeded);
    }
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        expect_array(&mut decoder, 8)?;
        entries.push(ManifestEntry {
            object_id: fixed_bytes(decoder.bytes()?)?,
            revision: decoder.u64()?,
            object_type: ll_crypto::ObjectType::try_from(decoder.u8()?)
                .map_err(|_| VersioningError::InvalidFormat)?,
            encrypted_path_blob_id: fixed_bytes(decoder.bytes()?)?,
            content_blob_id: decode_optional_fixed(&mut decoder)?,
            metadata_blob_id: decode_optional_fixed(&mut decoder)?,
            canonical_plaintext_hash: fixed_bytes(decoder.bytes()?)?,
            tombstone: decoder.bool()?,
        });
    }
    let manifest = Manifest { vault_id, entries };
    validate_manifest(&manifest)?;
    exact(encoded, decoder.position(), &encode_manifest(&manifest)?)?;
    Ok(manifest)
}

/// Encodes an encrypted-commit plaintext body deterministically.
///
/// # Errors
///
/// Returns a [`VersioningError`] for invariants, limits, or encoding.
pub fn encode_commit_body(body: &CommitBody) -> Result<Vec<u8>, VersioningError> {
    validate_commit_body(body)?;
    let mut output = Vec::new();
    let mut encoder = Encoder::new(&mut output);
    encoder
        .map(7)?
        .u8(0)?
        .u16(ll_protocol::PROTOCOL_VERSION)?
        .u8(1)?
        .u64(body.logical_timestamp)?
        .u8(2)?
        .array(as_u64(body.operations.len())?)?;
    for operation in &body.operations {
        encoder
            .array(6)?
            .u8(operation.kind as u8)?
            .bytes(&operation.object_id)?
            .u64(operation.base_revision)?
            .u64(operation.revision)?;
        encode_optional_fixed(&mut encoder, operation.encrypted_path_blob_id.as_ref())?;
        encode_optional_fixed(&mut encoder, operation.content_blob_id.as_ref())?;
    }
    encoder
        .u8(3)?
        .bytes(&body.manifest_root)?
        .u8(4)?
        .bytes(&body.manifest_blob_id)?
        .u8(5)?;
    encode_optional_fixed(&mut encoder, body.merge_base.as_ref())?;
    encoder.u8(6)?.array(as_u64(body.conflict_objects.len())?)?;
    for object_id in &body.conflict_objects {
        encoder.bytes(object_id)?;
    }
    if output.len() > MAX_COMMIT_BODY_BYTES {
        return Err(VersioningError::LimitExceeded);
    }
    Ok(output)
}

/// Decodes and exact-reencodes a client-only commit body.
///
/// # Errors
///
/// Returns a [`VersioningError`] for malformed, non-deterministic, or
/// oversized input.
pub fn decode_commit_body(encoded: &[u8]) -> Result<CommitBody, VersioningError> {
    if encoded.len() > MAX_COMMIT_BODY_BYTES {
        return Err(VersioningError::LimitExceeded);
    }
    let mut decoder = Decoder::new(encoded);
    expect_map(&mut decoder, 7)?;
    expect_key(&mut decoder, 0)?;
    expect_version(&mut decoder)?;
    expect_key(&mut decoder, 1)?;
    let logical_timestamp = decoder.u64()?;
    expect_key(&mut decoder, 2)?;
    let count = definite_array(&mut decoder)?;
    if count > MAX_OPERATIONS {
        return Err(VersioningError::LimitExceeded);
    }
    let mut operations = Vec::with_capacity(count);
    for _ in 0..count {
        expect_array(&mut decoder, 6)?;
        operations.push(Operation {
            kind: OperationKind::try_from(decoder.u8()?)?,
            object_id: fixed_bytes(decoder.bytes()?)?,
            base_revision: decoder.u64()?,
            revision: decoder.u64()?,
            encrypted_path_blob_id: decode_optional_fixed(&mut decoder)?,
            content_blob_id: decode_optional_fixed(&mut decoder)?,
        });
    }
    expect_key(&mut decoder, 3)?;
    let manifest_root = fixed_bytes(decoder.bytes()?)?;
    expect_key(&mut decoder, 4)?;
    let manifest_blob_id = fixed_bytes(decoder.bytes()?)?;
    expect_key(&mut decoder, 5)?;
    let merge_base = decode_optional_fixed(&mut decoder)?;
    expect_key(&mut decoder, 6)?;
    let conflicts = definite_array(&mut decoder)?;
    if conflicts > MAX_CONFLICT_OBJECTS {
        return Err(VersioningError::LimitExceeded);
    }
    let mut conflict_objects = Vec::with_capacity(conflicts);
    for _ in 0..conflicts {
        conflict_objects.push(fixed_bytes(decoder.bytes()?)?);
    }
    let body = CommitBody {
        logical_timestamp,
        operations,
        manifest_root,
        manifest_blob_id,
        merge_base,
        conflict_objects,
    };
    validate_commit_body(&body)?;
    exact(encoded, decoder.position(), &encode_commit_body(&body)?)?;
    Ok(body)
}

const MAX_COMMIT_BODY_BYTES: usize = crate::MAX_COMMIT_BODY_BYTES;

fn validate_manifest(manifest: &Manifest) -> Result<(), VersioningError> {
    if manifest.entries.len() > MAX_MANIFEST_ENTRIES
        || !manifest
            .entries
            .windows(2)
            .all(|pair| pair[0].object_id < pair[1].object_id)
    {
        return Err(VersioningError::LimitExceeded);
    }
    for entry in &manifest.entries {
        if entry.revision == 0
            || matches!(
                entry.object_type,
                ll_crypto::ObjectType::Path
                    | ll_crypto::ObjectType::Commit
                    | ll_crypto::ObjectType::Recovery
            )
            || (entry.tombstone && entry.content_blob_id.is_some())
            || (!entry.tombstone && entry.content_blob_id.is_none())
        {
            return Err(VersioningError::InvalidFormat);
        }
    }
    Ok(())
}

fn validate_commit_body(body: &CommitBody) -> Result<(), VersioningError> {
    if body.logical_timestamp == 0
        || body.operations.len() > MAX_OPERATIONS
        || body.conflict_objects.len() > MAX_CONFLICT_OBJECTS
        || !body
            .operations
            .windows(2)
            .all(|pair| operation_key(&pair[0]) < operation_key(&pair[1]))
        || !body
            .conflict_objects
            .windows(2)
            .all(|pair| pair[0] < pair[1])
    {
        return Err(VersioningError::InvalidFormat);
    }
    for operation in &body.operations {
        let expected_revision = operation
            .base_revision
            .checked_add(1)
            .ok_or(VersioningError::LimitExceeded)?;
        if operation.revision == 0
            || (operation.kind == OperationKind::Create && operation.base_revision != 0)
            || (operation.kind != OperationKind::Create && operation.base_revision == 0)
            || operation.revision != expected_revision
            || !operation_shape_is_valid(operation)
        {
            return Err(VersioningError::InvalidFormat);
        }
    }
    Ok(())
}

fn operation_shape_is_valid(operation: &Operation) -> bool {
    match operation.kind {
        OperationKind::Create => {
            operation.encrypted_path_blob_id.is_some() && operation.content_blob_id.is_some()
        }
        OperationKind::Modify | OperationKind::Merge => operation.content_blob_id.is_some(),
        OperationKind::Rename => {
            operation.encrypted_path_blob_id.is_some() && operation.content_blob_id.is_none()
        }
        OperationKind::DeleteTombstone => {
            operation.encrypted_path_blob_id.is_none() && operation.content_blob_id.is_none()
        }
    }
}

fn operation_key(operation: &Operation) -> ([u8; 16], u8) {
    (operation.object_id, operation.kind as u8)
}

fn encode_optional_fixed<W: minicbor::encode::Write, const N: usize>(
    encoder: &mut Encoder<W>,
    value: Option<&[u8; N]>,
) -> Result<(), minicbor::encode::Error<W::Error>> {
    encoder.bytes(value.map_or(&[], <[u8; N]>::as_slice))?;
    Ok(())
}

fn decode_optional_fixed<const N: usize>(
    decoder: &mut Decoder<'_>,
) -> Result<Option<[u8; N]>, VersioningError> {
    let bytes = decoder.bytes()?;
    if bytes.is_empty() {
        Ok(None)
    } else {
        fixed_bytes(bytes).map(Some)
    }
}

fn exact(original: &[u8], consumed: usize, encoded: &[u8]) -> Result<(), VersioningError> {
    if consumed == original.len() && bool::from(encoded.ct_eq(original)) {
        Ok(())
    } else {
        Err(VersioningError::InvalidFormat)
    }
}

fn expect_version(decoder: &mut Decoder<'_>) -> Result<(), VersioningError> {
    if decoder.u16()? == ll_protocol::PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(VersioningError::InvalidFormat)
    }
}

fn expect_map(decoder: &mut Decoder<'_>, expected: u64) -> Result<(), VersioningError> {
    if decoder.map()? == Some(expected) {
        Ok(())
    } else {
        Err(VersioningError::InvalidFormat)
    }
}

fn expect_key(decoder: &mut Decoder<'_>, expected: u8) -> Result<(), VersioningError> {
    if decoder.u8()? == expected {
        Ok(())
    } else {
        Err(VersioningError::InvalidFormat)
    }
}

fn expect_array(decoder: &mut Decoder<'_>, expected: usize) -> Result<(), VersioningError> {
    if definite_array(decoder)? == expected {
        Ok(())
    } else {
        Err(VersioningError::InvalidFormat)
    }
}

fn definite_array(decoder: &mut Decoder<'_>) -> Result<usize, VersioningError> {
    usize::try_from(decoder.array()?.ok_or(VersioningError::InvalidFormat)?)
        .map_err(|_| VersioningError::LimitExceeded)
}

fn as_u64(value: usize) -> Result<u64, VersioningError> {
    u64::try_from(value).map_err(|_| VersioningError::LimitExceeded)
}

fn fixed_bytes<const N: usize>(bytes: &[u8]) -> Result<[u8; N], VersioningError> {
    bytes.try_into().map_err(|_| VersioningError::InvalidFormat)
}

#[cfg(test)]
mod tests {
    use super::{
        CommitBody, Manifest, ManifestEntry, Operation, OperationKind, decode_commit_body,
        decode_manifest, encode_commit_body, encode_manifest,
    };

    fn vector_root() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../protocol/test-vectors/encrypted-versioning-v1.json"
        ))
        .unwrap()
    }

    fn vector_string<'a>(value: &'a serde_json::Value, key: &str) -> &'a str {
        value[key].as_str().unwrap()
    }

    fn vector_array<const N: usize>(value: &serde_json::Value, key: &str) -> [u8; N] {
        hex::decode(vector_string(value, key))
            .unwrap()
            .try_into()
            .unwrap()
    }

    #[test]
    fn manifest_and_commit_body_round_trip() {
        let manifest = Manifest::new(
            [1; 16],
            vec![ManifestEntry {
                object_id: [2; 16],
                revision: 1,
                object_type: ll_crypto::ObjectType::Content,
                encrypted_path_blob_id: [3; 32],
                content_blob_id: Some([4; 32]),
                metadata_blob_id: None,
                canonical_plaintext_hash: [5; 32],
                tombstone: false,
            }],
        )
        .unwrap();
        let manifest_encoded = encode_manifest(&manifest).unwrap();
        assert_eq!(decode_manifest(&manifest_encoded).unwrap(), manifest);

        let body = CommitBody {
            logical_timestamp: 1,
            operations: vec![Operation {
                kind: OperationKind::Create,
                object_id: [2; 16],
                base_revision: 0,
                revision: 1,
                encrypted_path_blob_id: Some([3; 32]),
                content_blob_id: Some([4; 32]),
            }],
            manifest_root: manifest.root().unwrap(),
            manifest_blob_id: [6; 32],
            merge_base: None,
            conflict_objects: Vec::new(),
        };
        let body_encoded = encode_commit_body(&body).unwrap();
        assert_eq!(decode_commit_body(&body_encoded).unwrap(), body);
    }

    #[test]
    fn manifest_and_body_match_shared_known_answer_vector() {
        let root = vector_root();
        let vector = &root["manifest"];
        let entry = &vector["entry"];
        let manifest = Manifest::new(
            vector_array(vector, "vault_id_hex"),
            vec![ManifestEntry {
                object_id: vector_array(entry, "object_id_hex"),
                revision: entry["revision"].as_u64().unwrap(),
                object_type: ll_crypto::ObjectType::try_from(
                    u8::try_from(entry["object_type"].as_u64().unwrap()).unwrap(),
                )
                .unwrap(),
                encrypted_path_blob_id: vector_array(entry, "encrypted_path_blob_id_hex"),
                content_blob_id: Some(vector_array(entry, "content_blob_id_hex")),
                metadata_blob_id: entry["metadata_blob_id_hex"]
                    .as_str()
                    .map(|_| vector_array(entry, "metadata_blob_id_hex")),
                canonical_plaintext_hash: vector_array(entry, "canonical_plaintext_hash_hex"),
                tombstone: entry["tombstone"].as_bool().unwrap(),
            }],
        )
        .unwrap();
        let encoded = encode_manifest(&manifest).unwrap();
        assert_eq!(hex::encode(&encoded), vector_string(vector, "encoded_hex"));
        assert_eq!(
            hex::encode(manifest.root().unwrap()),
            vector_string(vector, "root_hex")
        );
        let vector = &root["commit_body"];
        let operation = &vector["operation"];
        let body = CommitBody {
            logical_timestamp: vector["logical_timestamp"].as_u64().unwrap(),
            operations: vec![Operation {
                kind: OperationKind::try_from(
                    u8::try_from(operation["kind"].as_u64().unwrap()).unwrap(),
                )
                .unwrap(),
                object_id: vector_array(operation, "object_id_hex"),
                base_revision: operation["base_revision"].as_u64().unwrap(),
                revision: operation["revision"].as_u64().unwrap(),
                encrypted_path_blob_id: operation["encrypted_path_blob_id_hex"]
                    .as_str()
                    .map(|_| vector_array(operation, "encrypted_path_blob_id_hex")),
                content_blob_id: operation["content_blob_id_hex"]
                    .as_str()
                    .map(|_| vector_array(operation, "content_blob_id_hex")),
            }],
            manifest_root: vector_array(vector, "manifest_root_hex"),
            manifest_blob_id: vector_array(vector, "manifest_blob_id_hex"),
            merge_base: Some(vector_array(vector, "merge_base_hex")),
            conflict_objects: vec![vector_array(vector, "conflict_object_id_hex")],
        };
        let body_encoded = encode_commit_body(&body).unwrap();
        assert_eq!(
            hex::encode(body_encoded),
            vector_string(vector, "encoded_hex")
        );
    }
}
