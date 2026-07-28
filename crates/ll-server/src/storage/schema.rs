use rusqlite::Connection;

use crate::error::StorageError;

pub(super) fn migrate(connection: &mut Connection) -> Result<(), StorageError> {
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.execute_batch(
        "
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY NOT NULL,
            value BLOB NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS devices (
            device_id BLOB PRIMARY KEY NOT NULL CHECK(length(device_id) = 16),
            public_key BLOB NOT NULL CHECK(length(public_key) = 32),
            encrypted_name BLOB NOT NULL,
            registered_at INTEGER NOT NULL,
            revoked_at INTEGER
        ) STRICT;
        CREATE TABLE IF NOT EXISTS blobs (
            blob_id BLOB PRIMARY KEY NOT NULL CHECK(length(blob_id) = 32),
            ciphertext_size INTEGER NOT NULL CHECK(ciphertext_size >= 0),
            created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS uploads (
            upload_id BLOB PRIMARY KEY NOT NULL CHECK(length(upload_id) = 16),
            device_id BLOB NOT NULL REFERENCES devices(device_id),
            expected_size INTEGER NOT NULL CHECK(expected_size >= 0),
            expected_hash BLOB NOT NULL CHECK(length(expected_hash) = 32),
            received_size INTEGER NOT NULL CHECK(received_size >= 0),
            created_at INTEGER NOT NULL,
            UNIQUE(device_id, expected_size, expected_hash)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS uploads_created_at ON uploads(created_at);
        COMMIT;
        ",
    )?;
    Ok(())
}
