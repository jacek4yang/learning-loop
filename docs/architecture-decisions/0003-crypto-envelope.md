# ADR 0003: XChaCha envelope encryption with independent password domains

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

The server password controls service access but must not decrypt vault data. A
separate client password must unlock a random vault key without being persisted
or uploaded. Paths, metadata, commits, content, and attachments require domain
separation.

## Decision

- Generate a random 256-bit VMK per vault.
- Derive `content`, `path`, `metadata`, `commit`, `attachment`, and `recovery`
  subkeys with HKDF-SHA-256 and versioned labels.
- Derive a KEK from the client password using Argon2id with per-device
  calibration and bounded memory, then use it only to wrap the VMK.
- Generate a fresh DEK and 192-bit nonce for every object revision.
- Encrypt with RustCrypto XChaCha20-Poly1305 and bind the complete object
  identity in AAD.
- Wrap the DEK under the appropriate VMK subkey with a second fresh nonce.
- Use zeroizing containers for passwords, VMK, KEK, DEKs, and derived keys.

The server access password has a different persistent salt and Argon2id domain.
The plugin rejects equality between the two passwords after normalization and
rejects passwords that fail the local strength policy.

## Consequences

- Database or object-directory disclosure does not reveal plaintext or logical
  paths.
- Password loss is unrecoverable without exported recovery material.
- Randomness and nonce uniqueness are critical and receive fault/property tests.
- Device calibration results and KDF parameters are non-secret, but the client
  password itself is never stored in `data.json`.
