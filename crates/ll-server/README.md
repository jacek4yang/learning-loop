# Learning Loop Server

The server is a minimal opaque-object and encrypted-commit service. It has
three HTTP routes and
never accepts credentials, vault names, paths, or tokens in URLs or ordinary
headers. Authentication and every object operation run inside a pinned Noise
channel.

## Run from a release

Verify the release-level `SHA256SUMS`, extract the package for the host
architecture, and verify the archive's internal payload checksums. Copy
`config.example.toml` outside the application directory as `config.toml`, then
set the referenced environment variable and start the single binary:

```powershell
$env:LEARNING_LOOP_SERVER_PASSWORD = '<generate a strong unique value>'
.\ll-server.exe C:\absolute\path\to\config.toml
```

On Linux or macOS, use `./ll-server /absolute/path/to/config.toml`.

## Run from source

Copy `config.example.toml` from the repository root and set the password
through the referenced environment variable:

```powershell
$env:LEARNING_LOOP_SERVER_PASSWORD = '<generate a strong unique value>'
cargo run -p ll-server -- .\config.toml
```

The configuration accepts exactly `data_dir`, `listen`, and `password`.
Unknown fields and passwords shorter than 16 characters are rejected. On the
first start the server creates a persistent X25519 identity, fingerprint,
instance and vault identifiers, Argon2id salt and verifier, SQLite metadata,
and object directories.

Record the printed fingerprint through a trusted out-of-band channel. Back up
the complete data directory, especially `server-identity.key`; identity loss
is a disaster-recovery event and clients must reject the replacement key.

The service stores opaque ciphertext blobs plus deterministic signed commit
records. It validates device signatures, parent existence, per-device sequence,
and limits in one SQLite transaction, while never decrypting commit bodies or
interpreting paths. Exact duplicate commits are idempotent and concurrent
branches remain separate heads until a client submits a multi-parent merge.

Back up the complete stopped-server data directory, not only SQLite. See the
packaged README links in the repository documentation for installation,
operations, recovery, and the exact real-host validation status. Keep an
independent backup of every important Obsidian Vault.
