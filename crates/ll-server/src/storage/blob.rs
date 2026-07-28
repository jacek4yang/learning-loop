use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use ll_protocol::{MAX_CHUNK_BYTES, MAX_OBJECT_BYTES};
use rusqlite::{OptionalExtension, params};
use subtle::ConstantTimeEq;

use super::{Storage, now_unix_seconds, open_connection};
use crate::error::StorageError;

const MINIMUM_FREE_DISK_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ACTIVE_UPLOADS: i64 = 1024;
const MAX_ACTIVE_UPLOADS_PER_DEVICE: i64 = 32;

struct UploadRecord {
    upload_id: [u8; 16],
    expected_size: u64,
    expected_hash: [u8; 32],
    received_size: u64,
}

impl Storage {
    /// Allocates or resumes a bounded upload owned by an active device.
    ///
    /// # Errors
    ///
    /// Returns a [`StorageError`] for limits, disk reserve, device state, or
    /// durable storage failures.
    pub async fn begin_upload(
        &self,
        device_id: [u8; 16],
        expected_size: u64,
        expected_hash: [u8; 32],
    ) -> Result<([u8; 16], u64), StorageError> {
        if expected_size > MAX_OBJECT_BYTES {
            return Err(StorageError::LimitExceeded);
        }
        self.require_active_device(device_id).await?;
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let available = fs2::available_space(&storage.data_dir)?;
            if available < expected_size.saturating_add(MINIMUM_FREE_DISK_BYTES) {
                return Err(StorageError::InsufficientStorage);
            }
            let mut connection = open_connection(&storage.database_path)?;
            let transaction =
                connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            if let Some((upload_id, received)) = transaction
                .query_row(
                    "SELECT upload_id, received_size FROM uploads
                     WHERE device_id = ?1 AND expected_size = ?2 AND expected_hash = ?3",
                    params![
                        device_id.as_slice(),
                        i64::try_from(expected_size).map_err(|_| StorageError::LimitExceeded)?,
                        expected_hash.as_slice(),
                    ],
                    |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?
            {
                let upload_id = upload_id
                    .try_into()
                    .map_err(|_| StorageError::CorruptMetadata)?;
                let received =
                    u64::try_from(received).map_err(|_| StorageError::CorruptMetadata)?;
                transaction.commit()?;
                return Ok((upload_id, received));
            }
            let total_uploads: i64 =
                transaction.query_row("SELECT COUNT(*) FROM uploads", [], |row| row.get(0))?;
            let device_uploads: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM uploads WHERE device_id = ?1",
                [device_id.as_slice()],
                |row| row.get(0),
            )?;
            if total_uploads >= MAX_ACTIVE_UPLOADS
                || device_uploads >= MAX_ACTIVE_UPLOADS_PER_DEVICE
            {
                return Err(StorageError::LimitExceeded);
            }

            let upload_id = *uuid::Uuid::now_v7().as_bytes();
            let path = storage.upload_path(&upload_id);
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)?
                .sync_all()?;
            if let Err(error) = transaction.execute(
                "INSERT INTO uploads
                   (upload_id, device_id, expected_size, expected_hash, received_size, created_at)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5)",
                params![
                    upload_id.as_slice(),
                    device_id.as_slice(),
                    i64::try_from(expected_size).map_err(|_| StorageError::LimitExceeded)?,
                    expected_hash.as_slice(),
                    now_unix_seconds(),
                ],
            ) {
                let _ignored = fs::remove_file(path);
                return Err(StorageError::Database(error));
            }
            transaction.commit()?;
            Ok((upload_id, 0))
        })
        .await?
    }

    /// Appends a chunk only at the current durable offset.
    ///
    /// # Errors
    ///
    /// Returns a [`StorageError`] for missing upload, owner/revocation, offset,
    /// size, or durable storage failures.
    pub async fn append_upload_chunk(
        &self,
        device_id: [u8; 16],
        upload_id: [u8; 16],
        offset: u64,
        chunk: Vec<u8>,
    ) -> Result<u64, StorageError> {
        if chunk.is_empty() || chunk.len() > MAX_CHUNK_BYTES {
            return Err(StorageError::LimitExceeded);
        }
        self.require_active_device(device_id).await?;
        let _upload_guard = self.lock_upload(upload_id).await;
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = open_connection(&storage.database_path)?;
            let record = load_upload(&connection, &upload_id, &device_id)?;
            if record.received_size != offset {
                return Err(StorageError::OffsetMismatch);
            }
            let chunk_length =
                u64::try_from(chunk.len()).map_err(|_| StorageError::LimitExceeded)?;
            let new_offset = offset
                .checked_add(chunk_length)
                .ok_or(StorageError::LimitExceeded)?;
            if new_offset > record.expected_size {
                return Err(StorageError::LimitExceeded);
            }
            let path = storage.upload_path(&upload_id);
            let mut file = OpenOptions::new().read(true).write(true).open(path)?;
            let file_length = file.metadata()?.len();
            if file_length < offset {
                return Err(StorageError::IntegrityFailure);
            }
            if file_length > offset {
                file.set_len(offset)?;
                file.sync_all()?;
            }
            file.seek(SeekFrom::Start(offset))?;
            file.write_all(&chunk)?;
            file.sync_data()?;

            let transaction = connection.transaction()?;
            let changed = transaction.execute(
                "UPDATE uploads SET received_size = ?3
                 WHERE upload_id = ?1 AND received_size = ?2",
                params![
                    upload_id.as_slice(),
                    i64::try_from(offset).map_err(|_| StorageError::LimitExceeded)?,
                    i64::try_from(new_offset).map_err(|_| StorageError::LimitExceeded)?,
                ],
            )?;
            if changed != 1 {
                return Err(StorageError::OffsetMismatch);
            }
            transaction.commit()?;
            Ok(new_offset)
        })
        .await?
    }

    /// Fsyncs, verifies, atomically renames, and transactionally records an
    /// uploaded ciphertext object.
    ///
    /// # Errors
    ///
    /// Returns a [`StorageError`] for missing upload, revocation, incomplete
    /// data, hash mismatch, or durable storage failure.
    pub async fn commit_upload(
        &self,
        device_id: [u8; 16],
        upload_id: [u8; 16],
    ) -> Result<[u8; 32], StorageError> {
        self.require_active_device(device_id).await?;
        let _upload_guard = self.lock_upload(upload_id).await;
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = open_connection(&storage.database_path)?;
            let record = load_upload(&connection, &upload_id, &device_id)?;
            if record.received_size != record.expected_size {
                return Err(StorageError::IntegrityFailure);
            }
            let destination = storage.object_path(&record.expected_hash);
            if destination.exists() {
                verify_file(&destination, record.expected_size, &record.expected_hash)?;
            } else {
                let temporary = storage.upload_path(&record.upload_id);
                verify_file(&temporary, record.expected_size, &record.expected_hash)?;
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::rename(&temporary, &destination)?;
                sync_parent(&destination)?;
            }

            let transaction = connection.transaction()?;
            transaction.execute(
                "INSERT INTO blobs(blob_id, ciphertext_size, created_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(blob_id) DO NOTHING",
                params![
                    record.expected_hash.as_slice(),
                    i64::try_from(record.expected_size).map_err(|_| StorageError::LimitExceeded)?,
                    now_unix_seconds(),
                ],
            )?;
            transaction.execute(
                "DELETE FROM uploads WHERE upload_id = ?1",
                [upload_id.as_slice()],
            )?;
            transaction.commit()?;
            let temporary = storage.upload_path(&upload_id);
            if temporary.exists() {
                fs::remove_file(temporary)?;
            }
            Ok(record.expected_hash)
        })
        .await?
    }

    /// Reads one bounded ciphertext range.
    ///
    /// # Errors
    ///
    /// Returns a [`StorageError`] for invalid size/offset, missing blob, or
    /// durable storage failure.
    pub async fn read_blob_chunk(
        &self,
        blob_id: [u8; 32],
        offset: u64,
        maximum_bytes: u32,
    ) -> Result<(u64, bool, Vec<u8>), StorageError> {
        let maximum = usize::try_from(maximum_bytes).map_err(|_| StorageError::LimitExceeded)?;
        if maximum == 0 || maximum > MAX_CHUNK_BYTES {
            return Err(StorageError::LimitExceeded);
        }
        let storage = self.clone();
        tokio::task::spawn_blocking(move || {
            let connection = open_connection(&storage.database_path)?;
            let total: i64 = connection
                .query_row(
                    "SELECT ciphertext_size FROM blobs WHERE blob_id = ?1",
                    [blob_id.as_slice()],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or(StorageError::BlobNotFound)?;
            let total = u64::try_from(total).map_err(|_| StorageError::CorruptMetadata)?;
            if offset > total {
                return Err(StorageError::OffsetMismatch);
            }
            let mut file = File::open(storage.object_path(&blob_id))
                .map_err(|_| StorageError::IntegrityFailure)?;
            file.seek(SeekFrom::Start(offset))?;
            let remaining = total - offset;
            let count = usize::try_from(remaining.min(maximum as u64))
                .map_err(|_| StorageError::LimitExceeded)?;
            let mut chunk = vec![0_u8; count];
            file.read_exact(&mut chunk)?;
            let complete = offset.saturating_add(count as u64) == total;
            Ok((total, complete, chunk))
        })
        .await?
    }

    fn upload_path(&self, upload_id: &[u8; 16]) -> PathBuf {
        self.uploads_dir
            .join(format!("{}.part", hex::encode(upload_id)))
    }

    fn object_path(&self, blob_id: &[u8; 32]) -> PathBuf {
        let encoded = hex::encode(blob_id);
        self.objects_dir.join(&encoded[..2]).join(encoded)
    }
}

fn load_upload(
    connection: &rusqlite::Connection,
    upload_id: &[u8; 16],
    device_id: &[u8; 16],
) -> Result<UploadRecord, StorageError> {
    connection
        .query_row(
            "SELECT expected_size, expected_hash, received_size
             FROM uploads WHERE upload_id = ?1 AND device_id = ?2",
            params![upload_id.as_slice(), device_id.as_slice()],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?
        .map(|(expected_size, expected_hash, received_size)| {
            Ok::<UploadRecord, StorageError>(UploadRecord {
                upload_id: *upload_id,
                expected_size: u64::try_from(expected_size)
                    .map_err(|_| StorageError::CorruptMetadata)?,
                expected_hash: expected_hash
                    .try_into()
                    .map_err(|_| StorageError::CorruptMetadata)?,
                received_size: u64::try_from(received_size)
                    .map_err(|_| StorageError::CorruptMetadata)?,
            })
        })
        .transpose()?
        .ok_or(StorageError::UploadNotFound)
}

fn verify_file(
    path: &Path,
    expected_size: u64,
    expected_hash: &[u8; 32],
) -> Result<(), StorageError> {
    let mut file = OpenOptions::new().read(true).write(true).open(path)?;
    if file.metadata()?.len() != expected_size {
        return Err(StorageError::IntegrityFailure);
    }
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    if !bool::from(hasher.finalize().as_bytes().ct_eq(expected_hash)) {
        return Err(StorageError::IntegrityFailure);
    }
    file.sync_all()?;
    Ok(())
}

#[cfg(unix)]
fn sync_parent(path: &Path) -> Result<(), StorageError> {
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent(path: &Path) -> Result<(), StorageError> {
    let _metadata = fs::metadata(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use ll_testkit::{random_test_password, test_uuid};

    use super::Storage;
    use crate::error::StorageError;

    #[tokio::test]
    async fn upload_is_resumable_and_published_by_ciphertext_hash() {
        let directory = tempfile::tempdir().unwrap();
        let initialized =
            Storage::initialize(directory.path().to_owned(), random_test_password().unwrap())
                .await
                .unwrap();
        let device_id = test_uuid();
        initialized
            .storage
            .register_device(device_id, [3; 32], vec![4])
            .await
            .unwrap();

        let ciphertext = b"opaque ciphertext bytes";
        let hash = *blake3::hash(ciphertext).as_bytes();
        let (upload_id, offset) = initialized
            .storage
            .begin_upload(device_id, ciphertext.len() as u64, hash)
            .await
            .unwrap();
        assert_eq!(offset, 0);
        let offset = initialized
            .storage
            .append_upload_chunk(device_id, upload_id, 0, ciphertext.to_vec())
            .await
            .unwrap();
        assert_eq!(offset, ciphertext.len() as u64);
        assert_eq!(
            initialized
                .storage
                .commit_upload(device_id, upload_id)
                .await
                .unwrap(),
            hash
        );
        let (_, complete, downloaded) = initialized
            .storage
            .read_blob_chunk(hash, 0, 1024)
            .await
            .unwrap();
        assert!(complete);
        assert_eq!(downloaded, ciphertext);
    }

    #[tokio::test]
    async fn concurrent_duplicate_chunk_is_serialized_and_crash_tail_is_repaired() {
        let directory = tempfile::tempdir().unwrap();
        let initialized =
            Storage::initialize(directory.path().to_owned(), random_test_password().unwrap())
                .await
                .unwrap();
        let device_id = test_uuid();
        initialized
            .storage
            .register_device(device_id, [7; 32], vec![8])
            .await
            .unwrap();

        let ciphertext = b"one durable opaque chunk";
        let hash = *blake3::hash(ciphertext).as_bytes();
        let (upload_id, _) = initialized
            .storage
            .begin_upload(device_id, u64::try_from(ciphertext.len()).unwrap(), hash)
            .await
            .unwrap();
        let mut temporary = std::fs::OpenOptions::new()
            .append(true)
            .open(initialized.storage.upload_path(&upload_id))
            .unwrap();
        temporary.write_all(b"uncommitted crash tail").unwrap();
        temporary.sync_all().unwrap();
        drop(temporary);

        let first =
            initialized
                .storage
                .append_upload_chunk(device_id, upload_id, 0, ciphertext.to_vec());
        let second =
            initialized
                .storage
                .append_upload_chunk(device_id, upload_id, 0, ciphertext.to_vec());
        let (first, second) = tokio::join!(first, second);
        assert!(
            matches!(
                (&first, &second),
                (Ok(_), Err(StorageError::OffsetMismatch))
                    | (Err(StorageError::OffsetMismatch), Ok(_))
            ),
            "exactly one concurrent append must commit: first={first:?}, second={second:?}"
        );
        assert_eq!(
            initialized
                .storage
                .commit_upload(device_id, upload_id)
                .await
                .unwrap(),
            hash
        );
    }
}
