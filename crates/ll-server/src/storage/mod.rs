mod blob;
mod schema;
mod version;

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

use ll_crypto::{
    Argon2Policy, ServerAuthKey, derive_server_auth_key, random_array, server_auth_verifier,
    verify_server_auth_verifier,
};
use ll_protocol::DeviceRecord;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use zeroize::{Zeroize, Zeroizing};

use crate::error::StorageError;

const DATABASE_FILE: &str = "metadata.sqlite";
const STORAGE_KEY_FILE: &str = "server-storage.key";
const META_INSTANCE_ID: &str = "instance_id";
const META_VAULT_ID: &str = "vault_id";
const META_AUTH_SALT: &str = "authentication_salt";
const META_AUTH_VERIFIER: &str = "authentication_verifier";
const META_ARGON_MEMORY: &str = "argon2_memory_kib";
const META_ARGON_ITERATIONS: &str = "argon2_iterations";
const META_ARGON_PARALLELISM: &str = "argon2_parallelism";
const META_MIGRATION_VERSION: &str = "migration_version";
const CURRENT_MIGRATION_VERSION: u32 = 2;

type UploadLocks = Arc<Mutex<HashMap<[u8; 16], Weak<AsyncMutex<()>>>>>;

/// Cloneable paths and durable operations for the opaque service.
#[derive(Clone)]
pub struct Storage {
    data_dir: PathBuf,
    database_path: PathBuf,
    objects_dir: PathBuf,
    uploads_dir: PathBuf,
    vault_id: [u8; 16],
    upload_locks: UploadLocks,
}

/// Persistent server metadata and in-memory derived authentication key.
pub struct InitializedStorage {
    /// Durable object service.
    pub storage: Storage,
    /// Persistent instance identifier.
    pub instance_id: [u8; 16],
    /// Persistent opaque vault identifier.
    pub vault_id: [u8; 16],
    /// Persistent password salt.
    pub authentication_salt: [u8; 16],
    /// Persisted Argon2 policy.
    pub argon2_policy: Argon2Policy,
    /// Derived key retained only in zeroizing server memory.
    pub authentication_key: ServerAuthKey,
}

/// Stored registered-device state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredDevice {
    /// Device ID.
    pub device_id: [u8; 16],
    /// Ed25519 verifying key.
    pub public_key: [u8; 32],
    /// VMK-encrypted display name.
    pub encrypted_name: Vec<u8>,
    /// Revocation state.
    pub revoked: bool,
}

impl Storage {
    /// Initializes directories, `SQLite` schema, persistent metadata, storage
    /// key, and the server-password verifier.
    ///
    /// # Errors
    ///
    /// Returns a [`StorageError`] for filesystem, `SQLite`, randomness,
    /// metadata-corruption, Argon2, or password-verifier failures.
    pub async fn initialize(
        data_dir: PathBuf,
        mut password: Zeroizing<String>,
    ) -> Result<InitializedStorage, StorageError> {
        tokio::task::spawn_blocking(move || {
            fs::create_dir_all(&data_dir)?;
            let objects_dir = data_dir.join("objects");
            let versions_dir = data_dir.join("versions");
            let uploads_dir = data_dir.join("uploads");
            fs::create_dir_all(&objects_dir)?;
            fs::create_dir_all(&versions_dir)?;
            fs::create_dir_all(&uploads_dir)?;
            ensure_storage_key(&data_dir)?;

            let database_path = data_dir.join(DATABASE_FILE);
            let mut connection = open_connection(&database_path)?;
            schema::migrate(&mut connection)?;
            let transaction = connection.transaction()?;
            validate_migration_version(&transaction)?;

            let instance_id =
                get_or_create_fixed::<16>(&transaction, META_INSTANCE_ID, random_array::<16>)?;
            let vault_id =
                get_or_create_fixed::<16>(&transaction, META_VAULT_ID, random_array::<16>)?;
            version::repair_heads(&transaction, &vault_id)?;
            let authentication_salt =
                get_or_create_fixed::<16>(&transaction, META_AUTH_SALT, random_array::<16>)?;
            let policy = load_or_create_policy(&transaction)?;
            let authentication_key =
                derive_server_auth_key(password.as_bytes(), &authentication_salt, policy)?;
            password.zeroize();

            if let Some(persisted) = get_meta(&transaction, META_AUTH_VERIFIER)? {
                let verifier: [u8; 32] = persisted
                    .try_into()
                    .map_err(|_| StorageError::CorruptMetadata)?;
                verify_server_auth_verifier(&authentication_key, &verifier)
                    .map_err(|_| StorageError::PasswordMismatch)?;
            } else {
                set_meta(
                    &transaction,
                    META_AUTH_VERIFIER,
                    &server_auth_verifier(&authentication_key),
                )?;
            }
            set_meta(
                &transaction,
                META_MIGRATION_VERSION,
                &CURRENT_MIGRATION_VERSION.to_be_bytes(),
            )?;
            transaction.commit()?;

            Ok(InitializedStorage {
                storage: Storage {
                    data_dir,
                    database_path,
                    objects_dir,
                    uploads_dir,
                    vault_id,
                    upload_locks: Arc::new(Mutex::new(HashMap::new())),
                },
                instance_id,
                vault_id,
                authentication_salt,
                argon2_policy: policy,
                authentication_key,
            })
        })
        .await?
    }

    /// Returns the server data directory without revealing it to remote peers.
    #[must_use]
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Returns the persistent opaque vault identifier.
    #[must_use]
    pub const fn vault_id(&self) -> [u8; 16] {
        self.vault_id
    }

    /// Returns one device, including revoked state.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::DeviceNotFound`] or a durable storage error.
    pub async fn device(&self, device_id: [u8; 16]) -> Result<StoredDevice, StorageError> {
        let database = self.database_path.clone();
        tokio::task::spawn_blocking(move || {
            let connection = open_connection(&database)?;
            connection
                .query_row(
                    "SELECT public_key, encrypted_name, revoked_at IS NOT NULL
                     FROM devices WHERE device_id = ?1",
                    [device_id.as_slice()],
                    |row| {
                        let public_key: Vec<u8> = row.get(0)?;
                        let encrypted_name = row.get(1)?;
                        let revoked = row.get(2)?;
                        Ok((public_key, encrypted_name, revoked))
                    },
                )
                .optional()?
                .map(|(public_key, encrypted_name, revoked)| {
                    Ok::<StoredDevice, StorageError>(StoredDevice {
                        device_id,
                        public_key: public_key
                            .try_into()
                            .map_err(|_| StorageError::CorruptMetadata)?,
                        encrypted_name,
                        revoked,
                    })
                })
                .transpose()?
                .ok_or(StorageError::DeviceNotFound)
        })
        .await?
    }

    /// Inserts or explicitly reauthorizes a device with proof already checked.
    ///
    /// # Errors
    ///
    /// Returns a durable storage error.
    pub async fn register_device(
        &self,
        device_id: [u8; 16],
        public_key: [u8; 32],
        encrypted_name: Vec<u8>,
    ) -> Result<(), StorageError> {
        let database = self.database_path.clone();
        tokio::task::spawn_blocking(move || {
            let connection = open_connection(&database)?;
            connection.execute(
                "INSERT INTO devices
                   (device_id, public_key, encrypted_name, registered_at, revoked_at)
                 VALUES (?1, ?2, ?3, ?4, NULL)
                 ON CONFLICT(device_id) DO UPDATE SET
                   public_key = excluded.public_key,
                   encrypted_name = excluded.encrypted_name,
                   registered_at = excluded.registered_at,
                   revoked_at = NULL",
                params![
                    device_id.as_slice(),
                    public_key.as_slice(),
                    encrypted_name,
                    now_unix_seconds(),
                ],
            )?;
            Ok(())
        })
        .await?
    }

    /// Lists all opaque device records in stable device-ID order.
    ///
    /// # Errors
    ///
    /// Returns a durable storage or metadata error.
    pub async fn list_devices(&self) -> Result<Vec<DeviceRecord>, StorageError> {
        let database = self.database_path.clone();
        tokio::task::spawn_blocking(move || {
            let connection = open_connection(&database)?;
            let mut statement = connection.prepare(
                "SELECT device_id, public_key, encrypted_name, revoked_at IS NOT NULL
                 FROM devices ORDER BY device_id",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, bool>(3)?,
                ))
            })?;
            let mut devices = Vec::new();
            for row in rows {
                let (device_id, public_key, encrypted_name, revoked) = row?;
                devices.push(DeviceRecord {
                    device_id: device_id
                        .try_into()
                        .map_err(|_| StorageError::CorruptMetadata)?,
                    public_key: public_key
                        .try_into()
                        .map_err(|_| StorageError::CorruptMetadata)?,
                    encrypted_name,
                    revoked,
                });
            }
            Ok(devices)
        })
        .await?
    }

    /// Revokes a device. Revocation is checked on every subsequent operation.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::DeviceNotFound`] or a durable storage error.
    pub async fn revoke_device(&self, device_id: [u8; 16]) -> Result<(), StorageError> {
        let database = self.database_path.clone();
        tokio::task::spawn_blocking(move || {
            let connection = open_connection(&database)?;
            let changed = connection.execute(
                "UPDATE devices SET revoked_at = ?2
                 WHERE device_id = ?1 AND revoked_at IS NULL",
                params![device_id.as_slice(), now_unix_seconds()],
            )?;
            if changed == 0 {
                return Err(StorageError::DeviceNotFound);
            }
            Ok(())
        })
        .await?
    }

    /// Fails if a device is missing or revoked.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::DeviceNotFound`],
    /// [`StorageError::DeviceRevoked`], or a durable storage error.
    pub async fn require_active_device(
        &self,
        device_id: [u8; 16],
    ) -> Result<StoredDevice, StorageError> {
        let device = self.device(device_id).await?;
        if device.revoked {
            Err(StorageError::DeviceRevoked)
        } else {
            Ok(device)
        }
    }

    async fn lock_upload(&self, upload_id: [u8; 16]) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = lock_unpoisoned(&self.upload_locks);
            locks.retain(|_, lock| lock.strong_count() > 0);
            if let Some(lock) = locks.get(&upload_id).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(AsyncMutex::new(()));
                locks.insert(upload_id, Arc::downgrade(&lock));
                lock
            }
        };
        lock.lock_owned().await
    }
}

fn open_connection(path: &Path) -> Result<Connection, StorageError> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(connection)
}

fn get_meta(transaction: &Transaction<'_>, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
    Ok(transaction
        .query_row("SELECT value FROM metadata WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

fn set_meta(transaction: &Transaction<'_>, key: &str, value: &[u8]) -> Result<(), StorageError> {
    transaction.execute(
        "INSERT INTO metadata(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn validate_migration_version(transaction: &Transaction<'_>) -> Result<(), StorageError> {
    let Some(value) = get_meta(transaction, META_MIGRATION_VERSION)? else {
        return Ok(());
    };
    let bytes: [u8; 4] = value
        .try_into()
        .map_err(|_| StorageError::CorruptMetadata)?;
    let version = u32::from_be_bytes(bytes);
    if (1..=CURRENT_MIGRATION_VERSION).contains(&version) {
        Ok(())
    } else {
        Err(StorageError::CorruptMetadata)
    }
}

fn get_or_create_fixed<const N: usize>(
    transaction: &Transaction<'_>,
    key: &str,
    generate: impl FnOnce() -> Result<[u8; N], ll_crypto::CryptoError>,
) -> Result<[u8; N], StorageError> {
    if let Some(value) = get_meta(transaction, key)? {
        return value.try_into().map_err(|_| StorageError::CorruptMetadata);
    }
    let value = generate()?;
    set_meta(transaction, key, &value)?;
    Ok(value)
}

fn load_or_create_policy(transaction: &Transaction<'_>) -> Result<Argon2Policy, StorageError> {
    let defaults = Argon2Policy::SERVER_DEFAULT;
    let memory = get_or_create_u32(transaction, META_ARGON_MEMORY, defaults.memory_kib)?;
    let iterations = get_or_create_u32(transaction, META_ARGON_ITERATIONS, defaults.iterations)?;
    let parallelism = get_or_create_u32(transaction, META_ARGON_PARALLELISM, defaults.parallelism)?;
    let policy = Argon2Policy {
        memory_kib: memory,
        iterations,
        parallelism,
    };
    policy.argon2()?;
    Ok(policy)
}

fn get_or_create_u32(
    transaction: &Transaction<'_>,
    key: &str,
    default: u32,
) -> Result<u32, StorageError> {
    if let Some(value) = get_meta(transaction, key)? {
        let bytes: [u8; 4] = value
            .try_into()
            .map_err(|_| StorageError::CorruptMetadata)?;
        return Ok(u32::from_be_bytes(bytes));
    }
    set_meta(transaction, key, &default.to_be_bytes())?;
    Ok(default)
}

fn ensure_storage_key(data_dir: &Path) -> Result<(), StorageError> {
    let path = data_dir.join(STORAGE_KEY_FILE);
    if path.exists() {
        let bytes = fs::read(path)?;
        if bytes.len() != 32 {
            return Err(StorageError::CorruptMetadata);
        }
        return Ok(());
    }
    let mut key = Zeroizing::new(random_array::<32>()?);
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    set_private_mode(&mut options);
    let mut file = options.open(path)?;
    file.write_all(key.as_ref())?;
    file.sync_all()?;
    key.zeroize();
    Ok(())
}

#[cfg(unix)]
fn set_private_mode(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(not(unix))]
fn set_private_mode(_options: &mut OpenOptions) {}

fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)
        })
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use ll_testkit::random_test_password;
    use rusqlite::params;

    use super::{DATABASE_FILE, META_MIGRATION_VERSION, Storage};

    #[tokio::test]
    async fn metadata_and_password_verifier_survive_restart() {
        let directory = tempfile::tempdir().unwrap();
        let password = random_test_password().unwrap();
        let first = Storage::initialize(directory.path().to_owned(), password.clone())
            .await
            .unwrap();
        let instance = first.instance_id;
        let vault = first.vault_id;
        drop(first);

        let second = Storage::initialize(directory.path().to_owned(), password)
            .await
            .unwrap();
        assert_eq!(second.instance_id, instance);
        assert_eq!(second.vault_id, vault);
    }

    #[tokio::test]
    async fn refuses_unknown_future_schema() {
        let directory = tempfile::tempdir().unwrap();
        let password = random_test_password().unwrap();
        drop(
            Storage::initialize(directory.path().to_owned(), password.clone())
                .await
                .unwrap(),
        );
        let connection = rusqlite::Connection::open(directory.path().join(DATABASE_FILE)).unwrap();
        connection
            .execute(
                "UPDATE metadata SET value = ?2 WHERE key = ?1",
                params![META_MIGRATION_VERSION, 999_u32.to_be_bytes()],
            )
            .unwrap();
        drop(connection);

        let error = Storage::initialize(directory.path().to_owned(), password)
            .await
            .err()
            .unwrap();
        assert!(matches!(error, crate::error::StorageError::CorruptMetadata));
    }

    #[tokio::test]
    async fn rebuilds_head_index_from_immutable_parent_edges() {
        let directory = tempfile::tempdir().unwrap();
        let password = random_test_password().unwrap();
        let first = Storage::initialize(directory.path().to_owned(), password.clone())
            .await
            .unwrap();
        let vault_id = first.vault_id;
        let device_id = [1; 16];
        first
            .storage
            .register_device(device_id, [2; 32], Vec::new())
            .await
            .unwrap();
        drop(first);

        let mut connection =
            rusqlite::Connection::open(directory.path().join(DATABASE_FILE)).unwrap();
        let transaction = connection.transaction().unwrap();
        for (commit_id, sequence, generation) in [
            ([10_u8; 32], 1_i64, 0_i64),
            ([11; 32], 2, 1),
            ([12; 32], 3, 1),
        ] {
            transaction
                .execute(
                    "INSERT INTO commits
                       (commit_id, vault_id, device_id, device_sequence, generation,
                        signed_record, inserted_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
                    params![
                        commit_id.as_slice(),
                        vault_id.as_slice(),
                        device_id.as_slice(),
                        sequence,
                        generation,
                        vec![u8::try_from(sequence).unwrap()],
                    ],
                )
                .unwrap();
        }
        for child in [[11_u8; 32], [12; 32]] {
            transaction
                .execute(
                    "INSERT INTO commit_parents(commit_id, parent_id) VALUES (?1, ?2)",
                    params![child.as_slice(), [10_u8; 32].as_slice()],
                )
                .unwrap();
        }
        transaction.commit().unwrap();
        drop(connection);

        let restarted = Storage::initialize(directory.path().to_owned(), password)
            .await
            .unwrap();
        assert_eq!(
            restarted.storage.heads().await.unwrap(),
            vec![[11_u8; 32], [12; 32]]
        );
    }
}
