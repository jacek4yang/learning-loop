use std::collections::BTreeSet;

use ll_protocol::{MAX_CHANGES_PER_RESPONSE, MAX_HEADS, MAX_KNOWN_COMMITS};
use ll_versioning::SignedCommit;
use rusqlite::{OptionalExtension, params};
use subtle::ConstantTimeEq;

use super::{Storage, now_unix_seconds, open_connection};
use crate::error::StorageError;

const MAX_COMMITS_PER_VAULT: i64 = 1_000_000;

pub(super) fn repair_heads(
    transaction: &rusqlite::Transaction<'_>,
    vault_id: &[u8; 16],
) -> Result<(), StorageError> {
    transaction.execute(
        "DELETE FROM heads WHERE vault_id = ?1",
        [vault_id.as_slice()],
    )?;
    transaction.execute(
        "INSERT INTO heads(vault_id, commit_id)
         SELECT ?1, candidate.commit_id
         FROM commits AS candidate
         WHERE candidate.vault_id = ?1
           AND NOT EXISTS (
               SELECT 1
               FROM commit_parents AS edge
               JOIN commits AS child ON child.commit_id = edge.commit_id
               WHERE edge.parent_id = candidate.commit_id
                 AND child.vault_id = ?1
           )",
        [vault_id.as_slice()],
    )?;
    Ok(())
}

impl Storage {
    /// Atomically validates graph/device sequence rules, inserts an immutable
    /// commit, and advances the head set.
    ///
    /// Exact duplicate records are idempotent.
    ///
    /// # Errors
    ///
    /// Returns a [`StorageError`] for revocation, vault/device mismatch,
    /// sequence conflict, missing parents, root violations, capacity, or
    /// durable storage failure.
    pub async fn accept_commit(
        &self,
        session_device_id: [u8; 16],
        commit: SignedCommit,
        signed_record: Vec<u8>,
    ) -> Result<([u8; 32], Vec<[u8; 32]>), StorageError> {
        self.require_active_device(session_device_id).await?;
        if commit.unsigned.device_id != session_device_id
            || commit.unsigned.vault_id != self.vault_id
        {
            return Err(StorageError::InvalidCommit);
        }
        let database = self.database_path.clone();
        let vault_id = self.vault_id;
        tokio::task::spawn_blocking(move || {
            let mut connection = open_connection(&database)?;
            let transaction =
                connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            require_active_in_transaction(&transaction, &session_device_id)?;

            if let Some(existing) = transaction
                .query_row(
                    "SELECT signed_record FROM commits WHERE commit_id = ?1",
                    [commit.commit_id.as_slice()],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .optional()?
            {
                if !bool::from(existing.ct_eq(&signed_record)) {
                    return Err(StorageError::CommitConflict);
                }
                let heads = load_heads(&transaction, &vault_id)?;
                transaction.commit()?;
                return Ok((commit.commit_id, heads));
            }

            let commit_count: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM commits WHERE vault_id = ?1",
                [vault_id.as_slice()],
                |row| row.get(0),
            )?;
            if commit_count >= MAX_COMMITS_PER_VAULT {
                return Err(StorageError::LimitExceeded);
            }
            if (commit_count == 0) != commit.unsigned.parents.is_empty() {
                return Err(StorageError::InvalidCommit);
            }
            validate_next_device_sequence(
                &transaction,
                &vault_id,
                &session_device_id,
                commit.unsigned.device_sequence,
            )?;
            let generation =
                load_parent_generation(&transaction, &vault_id, &commit.unsigned.parents)?;

            transaction.execute(
                "INSERT INTO commits
                   (commit_id, vault_id, device_id, device_sequence, generation,
                    signed_record, inserted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    commit.commit_id.as_slice(),
                    vault_id.as_slice(),
                    session_device_id.as_slice(),
                    i64::try_from(commit.unsigned.device_sequence)
                        .map_err(|_| StorageError::LimitExceeded)?,
                    generation,
                    signed_record,
                    now_unix_seconds(),
                ],
            )?;
            for parent in &commit.unsigned.parents {
                transaction.execute(
                    "INSERT INTO commit_parents(commit_id, parent_id) VALUES (?1, ?2)",
                    params![commit.commit_id.as_slice(), parent.as_slice()],
                )?;
                transaction.execute(
                    "DELETE FROM heads WHERE vault_id = ?1 AND commit_id = ?2",
                    params![vault_id.as_slice(), parent.as_slice()],
                )?;
            }
            transaction.execute(
                "INSERT INTO heads(vault_id, commit_id) VALUES (?1, ?2)",
                params![vault_id.as_slice(), commit.commit_id.as_slice()],
            )?;
            let heads = load_heads(&transaction, &vault_id)?;
            transaction.commit()?;
            Ok((commit.commit_id, heads))
        })
        .await?
    }

    /// Returns one exact signed commit record.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::CommitNotFound`] or a durable storage error.
    pub async fn get_commit(&self, commit_id: [u8; 32]) -> Result<Vec<u8>, StorageError> {
        let database = self.database_path.clone();
        let vault_id = self.vault_id;
        tokio::task::spawn_blocking(move || {
            let connection = open_connection(&database)?;
            connection
                .query_row(
                    "SELECT signed_record FROM commits
                     WHERE vault_id = ?1 AND commit_id = ?2",
                    params![vault_id.as_slice(), commit_id.as_slice()],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or(StorageError::CommitNotFound)
        })
        .await?
    }

    /// Returns the current sorted head set.
    ///
    /// # Errors
    ///
    /// Returns a durable storage or metadata error.
    pub async fn heads(&self) -> Result<Vec<[u8; 32]>, StorageError> {
        let database = self.database_path.clone();
        let vault_id = self.vault_id;
        tokio::task::spawn_blocking(move || {
            let connection = open_connection(&database)?;
            load_heads(&connection, &vault_id)
        })
        .await?
    }

    /// Returns a bounded parents-before-children batch absent from `known`.
    ///
    /// # Errors
    ///
    /// Returns a limit, durable storage, or metadata error.
    pub async fn changes(
        &self,
        known: Vec<[u8; 32]>,
        maximum: u16,
    ) -> Result<(Vec<Vec<u8>>, bool), StorageError> {
        if known.len() > MAX_KNOWN_COMMITS
            || maximum == 0
            || usize::from(maximum) > MAX_CHANGES_PER_RESPONSE
        {
            return Err(StorageError::LimitExceeded);
        }
        let database = self.database_path.clone();
        let vault_id = self.vault_id;
        tokio::task::spawn_blocking(move || {
            let known: BTreeSet<_> = known.into_iter().collect();
            let connection = open_connection(&database)?;
            let mut statement = connection.prepare(
                "SELECT commit_id, signed_record FROM commits
                 WHERE vault_id = ?1 ORDER BY generation, commit_id",
            )?;
            let rows = statement.query_map([vault_id.as_slice()], |row| {
                Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?))
            })?;
            let requested = usize::from(maximum);
            let mut commits = Vec::with_capacity(requested);
            let mut has_more = false;
            for row in rows {
                let (commit_id, record) = row?;
                let commit_id: [u8; 32] = commit_id
                    .try_into()
                    .map_err(|_| StorageError::CorruptMetadata)?;
                if known.contains(&commit_id) {
                    continue;
                }
                if commits.len() == requested {
                    has_more = true;
                    break;
                }
                commits.push(record);
            }
            Ok((commits, has_more))
        })
        .await?
    }
}

fn require_active_in_transaction(
    transaction: &rusqlite::Transaction<'_>,
    device_id: &[u8; 16],
) -> Result<(), StorageError> {
    let active: Option<bool> = transaction
        .query_row(
            "SELECT revoked_at IS NULL FROM devices WHERE device_id = ?1",
            [device_id.as_slice()],
            |row| row.get(0),
        )
        .optional()?;
    match active {
        Some(true) => Ok(()),
        Some(false) => Err(StorageError::DeviceRevoked),
        None => Err(StorageError::DeviceNotFound),
    }
}

fn validate_next_device_sequence(
    transaction: &rusqlite::Transaction<'_>,
    vault_id: &[u8; 16],
    device_id: &[u8; 16],
    supplied: u64,
) -> Result<(), StorageError> {
    let previous: Option<i64> = transaction.query_row(
        "SELECT MAX(device_sequence) FROM commits
         WHERE vault_id = ?1 AND device_id = ?2",
        params![vault_id.as_slice(), device_id.as_slice()],
        |row| row.get(0),
    )?;
    let expected = previous
        .unwrap_or(0)
        .checked_add(1)
        .ok_or(StorageError::LimitExceeded)?;
    if i64::try_from(supplied).map_err(|_| StorageError::LimitExceeded)? == expected {
        Ok(())
    } else {
        Err(StorageError::InvalidCommit)
    }
}

fn load_parent_generation(
    transaction: &rusqlite::Transaction<'_>,
    vault_id: &[u8; 16],
    parents: &[[u8; 32]],
) -> Result<i64, StorageError> {
    if parents.is_empty() {
        return Ok(0);
    }
    let mut maximum = -1;
    for parent in parents {
        let generation: Option<i64> = transaction
            .query_row(
                "SELECT generation FROM commits
                 WHERE vault_id = ?1 AND commit_id = ?2",
                params![vault_id.as_slice(), parent.as_slice()],
                |row| row.get(0),
            )
            .optional()?;
        maximum = maximum.max(generation.ok_or(StorageError::MissingParent)?);
    }
    maximum.checked_add(1).ok_or(StorageError::LimitExceeded)
}

fn load_heads(
    connection: &rusqlite::Connection,
    vault_id: &[u8; 16],
) -> Result<Vec<[u8; 32]>, StorageError> {
    let mut statement =
        connection.prepare("SELECT commit_id FROM heads WHERE vault_id = ?1 ORDER BY commit_id")?;
    let rows = statement.query_map([vault_id.as_slice()], |row| row.get::<_, Vec<u8>>(0))?;
    let mut heads = Vec::new();
    for row in rows {
        if heads.len() >= MAX_HEADS {
            return Err(StorageError::LimitExceeded);
        }
        heads.push(row?.try_into().map_err(|_| StorageError::CorruptMetadata)?);
    }
    Ok(heads)
}
