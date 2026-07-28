# Learning Loop threat model

Status: design baseline for protocol version 1

## Security goals

- The server and a passive or active network observer cannot recover plaintext
  note content, logical paths, filenames, Properties, Canvas content, commit
  bodies, or attachment content.
- A client without the server access password cannot upload or download opaque
  vault objects.
- Possession of the server access password does not decrypt vault data.
- A client rejects a server whose long-term Noise public key does not match the
  configured SHA-256 fingerprint.
- A revoked device cannot add a new signed commit.
- Tampering, substitution, truncation, replay, downgrade, and parent omission
  are detected before state is applied.
- Path and Unicode collisions never cause silent overwrite.

## Assets

| Asset | Location | Lifetime | Consequence of loss or disclosure |
| --- | --- | --- | --- |
| Server Noise identity private key | server data directory | instance lifetime | Loss changes fingerprint and is a disaster-recovery event; disclosure enables server impersonation. |
| Server access password | configuration / environment, then transient memory | operator controlled | Disclosure authorizes ciphertext access and device registration, but not decryption. |
| Server authentication verifier and salt | server data directory | until rotation | Database disclosure enables offline password guessing and server impersonation after a successful guess. |
| Vault master key (VMK) | random client secret, stored only as encrypted envelope | vault lifetime | Disclosure decrypts the entire vault. |
| Client encryption password | user input and transient memory only | unlock session | Loss is unrecoverable without separately backed-up recovery material; disclosure can unwrap the VMK. |
| Device Ed25519 private key | client secure storage, encrypted at rest | device authorization | Disclosure permits signed commits until revocation. |
| Session keys | client/server memory | one short session | Disclosure exposes that session only; later sessions use fresh ephemeral keys. |
| Plain local Markdown | Obsidian vault | while present | Protected by OS full-disk encryption, not by the sync protocol. |

## Trust boundaries

1. **User to plugin:** passwords enter trusted UI but must not enter logs,
   `data.json`, URLs, query strings, or ordinary headers.
2. **Plugin to Obsidian:** unlocked plaintext is visible to Obsidian and other
   enabled plugins. Learning Loop does not claim to isolate a hostile local
   plugin.
3. **Client to network:** all data after bootstrap is inside a pinned Noise
   channel; HTTP routing metadata and traffic shape remain observable.
4. **Network to server:** unauthenticated work is tightly bounded; upload and
   vault access follow password and device authentication.
5. **Server process to storage:** SQLite holds only opaque identifiers,
   ciphertext metadata, signatures, and limits. Blob files are ciphertext.
6. **Host operating system:** an administrator of an unlocked client can read
   plaintext and process memory. An administrator of the server can deny
   service, roll back data, or observe access patterns.

## Adversaries

- Passive network observer.
- Active man-in-the-middle able to intercept, replay, reorder, truncate, or
  replace HTTP traffic.
- Unauthenticated internet client attempting resource exhaustion or junk
  uploads.
- Authenticated client with the server password but not the vault password.
- Compromised or later-revoked device.
- Attacker with a copy of SQLite and the object directory.
- Malicious filename or vault content attempting traversal, collision, parser
  confusion, or resource exhaustion.
- Crash, power loss, disk-full condition, database lock, duplicated message, or
  interrupted mobile process.

## Explicit non-goals and residual risks

- Traffic timing, server IP, ciphertext sizes within configured padding/chunk
  policy, and the fact that devices synchronize are not hidden.
- A malicious server can deny service, omit objects, retain deleted ciphertext,
  or serve an older but correctly signed graph. Clients detect invalid
  signatures and local rollback relative to remembered state, but a brand-new
  client needs another trusted device or recovery checkpoint to prove
  freshness.
- The server access verifier permits offline guessing after storage compromise;
  Argon2id raises cost but cannot rescue a weak password.
- Once unlocked, local Markdown is plaintext for native Obsidian behavior.
  Other local plugins and a compromised operating system are outside the
  end-to-end transport boundary.
- File existence and coarse size relationships may be inferred unless optional
  padding is enabled in a future version.
- Recovery cannot reconstruct a forgotten client password from the server.

## Protocol mitigations

### Server authentication and downgrade resistance

- The client is provisioned out of band with
  `SHA256(server_noise_static_public_key)`.
- Bootstrap data is limited to the public key, fingerprint, instance ID,
  protocol version, exact suite, and conservative size limits.
- The client hashes the returned public key and compares it in constant time
  with the configured fingerprint. Mismatch is fatal; there is no bypass.
- The fixed suite is `Noise_NK_25519_ChaChaPoly_BLAKE2s`.
- The prologue is deterministic CBOR over the product marker, protocol version,
  server instance ID, and suite. Any modification changes the handshake hash.
- Both peers generate a fresh ephemeral Noise key for each session. Session IDs,
  challenges, and message counters are never reused.

### Authorization

- After Noise split, the server sends a random challenge in an encrypted
  message.
- The client derives an authentication key from the server password and the
  persistent server salt using Argon2id, then returns an HMAC over the handshake
  hash, challenge, session ID, and role label.
- The original password is zeroized promptly. Passwords and derived response
  values are never logged.
- Registration requires successful password authentication. Established devices
  additionally sign the challenge with their Ed25519 identity.
- Commit acceptance checks the device registry and signature inside the same
  transaction that advances heads.

### End-to-end object protection

- The client creates a random 256-bit VMK and derives independent content, path,
  metadata, commit, attachment, and recovery keys with HKDF-SHA-256 labels.
- Each object revision gets a fresh random 256-bit DEK and 192-bit
  XChaCha20-Poly1305 nonce.
- The DEK is wrapped under the appropriate VMK-derived key with a separate
  random nonce.
- AAD binds the protocol version, vault ID, object ID, revision, object type,
  and cipher suite.
- The client password derives a KEK with calibrated, bounded Argon2id parameters
  and unwraps the random VMK. The password is never persisted or uploaded.
- Nonce values are carried in signed/encrypted envelopes and tested for
  duplicates per key domain.

### Integrity and version history

- Deterministic CBOR is decoded and re-encoded before a hash or signature is
  accepted.
- Opaque objects are addressed by BLAKE3 over the exact ciphertext envelope.
- A commit ID is BLAKE3 over the unsigned outer envelope; the device signs a
  domain-separated digest containing that ID.
- Commits are immutable and contain zero, one, or multiple parent IDs.
- The server rejects missing parents except for a root commit, duplicate device
  sequence numbers with different content, oversized fields, invalid
  signatures, and commits from revoked devices.
- Head updates are transactional. Clients calculate common ancestors and
  three-way merges; the server never sees or merges plaintext.

### Filesystem safety

- Portable paths are relative, NFC-normalized UTF-8 with `/` separators.
- `.`/`..`, absolute paths, control characters, Windows-invalid characters,
  reserved device names, alternate data streams, trailing space/dot, and
  conservative length violations are rejected.
- A collision key uses NFC plus Unicode default case folding. Collisions block
  sync and require a user-confirmed rename commit.
- Writes use Obsidian's Vault API. A downloaded object is verified, decrypted,
  canonicalized, checked for collision, written, and recorded for echo
  suppression in that order.
- Symlinks, hard links, junctions, and non-file adapters are not followed by the
  synchronization model.

### Availability and crash consistency

- Before authentication, the server applies connection, handshake-size,
  timeout, per-IP, global-rate, and exponential-backoff limits.
- Object and message sizes, concurrent uploads, temporary bytes, free disk
  space, and version counts have built-in hard caps.
- Uploads stream to a random temporary file, validate length and BLAKE3, flush
  and fsync, atomically rename into append-only storage, then commit SQLite
  metadata and head changes.
- Idempotency keys and content addressing make retries safe. Incomplete
  temporary files are never visible as objects.
- The client persists pending operations before network I/O and reconciles
  local content hashes after restart. An empty new vault is not a deletion set.

## Abuse cases and required tests

| Abuse case | Required outcome |
| --- | --- |
| MITM substitutes bootstrap key | Fingerprint mismatch before password use. |
| Handshake suite/version is altered | Prologue or fixed-suite validation fails. |
| Encrypted message is replayed or reordered | Session sequence/Noise nonce check rejects it. |
| Wrong server password | Generic delayed authentication failure; no vault metadata. |
| Authenticated junk upload | Device authorization, quotas, hash, and transaction checks reject it. |
| Ciphertext/blob replacement | Address, AEAD, commit signature, or manifest root fails. |
| Device signature forgery | Ed25519 verification fails. |
| Revoked device submits a commit | Registry transaction rejects it. |
| `../`, reserved name, symlink, or collision | Portable-path validation blocks application. |
| Parser length overflow or compression bomb | Bounded decoder rejects before allocation/decompression. |
| Database/object directory is copied | No plaintext path, note, Property, Canvas, or attachment is recoverable. |
| Server identity key changes | Every pinned client refuses the new fingerprint. |
| Plugin locks | In-memory secrets zeroized and sync stops; local Markdown is not falsely claimed to be encrypted. |

## Logging rules

Logs may contain an event code, coarse result, request correlation ID, opaque
device ID, aggregate byte count, and bounded timing. Logs must not contain a
password, verifier, response proof, private or session key, plaintext path,
title, content, decrypted Properties, vault name, ciphertext body, URL-supplied
secret, or full untrusted error string.

## Review triggers

Re-review this model when changing a cipher suite, encoding, KDF policy, device
registration, recovery design, merge semantics, server storage transaction,
Obsidian API boundary, or supported platform.
