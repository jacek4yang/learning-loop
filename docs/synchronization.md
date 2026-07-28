# Encrypted synchronization

## Runtime boundary

The TypeScript plugin owns Obsidian events, IndexedDB state, fixed-route HTTP,
and user interface state. Rust compiled to WebAssembly owns path and text
canonicalization, BLAKE3, Argon2id VMK wrapping, XChaCha20-Poly1305 object
envelopes, Ed25519 device identities, deterministic CBOR, commit signing, and
the ordered Noise channel.

The plugin starts locked. A configured device persists only:

```text
DDNS hostname and port
pinned server fingerprint
device display name
SecretStorage reference for the server password
opaque vault ID
password-wrapped VMK envelope
VMK-encrypted device signing identity
```

The client encryption password is never persisted or sent. Locking frees the
WASM vault and device objects, closes the Noise session, cancels debounced work,
and stops synchronization. It does not encrypt ordinary local Markdown.

## Connection and device recovery

Every connection performs a new pinned Noise NK handshake over the three fixed
HTTP routes. An existing device unlocks its VMK and signing identity before
proving possession. A new device first proves only the independent server
password, receives the opaque vault ID and password-wrapped VMK, unlocks it with
the user-entered client password, creates a fresh Ed25519 identity, and
registers that identity inside the encrypted channel.

For a new server, the first authenticated client creates a random VMK and
initializes the wrapped envelope exactly once. A different later envelope is a
hard conflict.

## Local state and upload ordering

IndexedDB stores paths, canonical hashes, object/revision IDs, commit summaries,
pending operations, upload progress, and prepared signed commits. It never
stores note bodies. A separate IndexedDB store holds staged ciphertext needed
for process-death recovery.

The upload state machine is:

```text
full reconciliation scan
-> persist pending operations
-> canonicalize and re-check the current file
-> encrypt path/content exactly once
-> persist ciphertext before network I/O
-> begin or resume by ciphertext size and BLAKE3
-> send exact-offset chunks
-> fsync/publish on the server
-> persist the exact signed commit before PUT
-> idempotently PUT that byte-identical commit
-> atomically advance local records and heads
-> remove staged ciphertext
```

A lost chunk response resumes from the server's durable offset. A lost commit
response reuses the exact prepared signature. Local events are debounced for
two seconds, and a full scan runs every five minutes while unlocked.

## Download, verification, and merge

The client lists active device public keys, requests parents-before-children
changes, and accepts a commit only after one registered key verifies its
signature and every parent is known. It then downloads and decrypts the
manifest, recomputes its Merkle root, validates the vault ID, decrypts portable
paths, and verifies each content plaintext hash.

For one head, the signed manifest is the target snapshot. For concurrent heads,
the client finds the nearest common ancestor, compares complete object entries,
chooses a deterministic Lamport/commit-ID winner, and preserves other changed
versions as conflict copies. Markdown receives a conservative line-oriented
three-way merge. `.canvas`, `.base`, JSON, and binary files are not deeply
merged; both versions are preserved. Unsafe delete/modify, rename, same-path
create, and file/directory cases create a conflict copy and a Markdown record
under `00-Inbox/Sync Conflicts/`. Original files never receive Git conflict
markers.

Remote writes use `Vault.process()` for existing text, official binary and
rename APIs for other mutations, `normalizePath()`, and short-lived
hash-matched echo suppression. The next reconciliation turns merged or
conflict files into normal encrypted operations and creates a multi-parent
commit when appropriate.

## Platform status

The implementation contains no Node filesystem, Electron, native SQLite,
axios, Git, WebDAV, or third-party synchronization dependency. It uses
`requestUrl`, `Platform`, `Vault.configDir`, registered Obsidian events, and
foreground commands on mobile.

Automated Rust, WASM, TypeScript, failure-injection, and loopback transport
checks pass in the development environment. Real Obsidian transport and
end-to-end recovery evidence on Windows, Linux, macOS, and Android remains a
v1.0 release gate; unavailable environments are not reported as passing.
