# Learning Loop protocol version 1

Status: design baseline; wire compatibility is not stable before v1.0.0.

## Principles

- One ordinary TCP listener serves a minimal HTTP/1.1 request-response API.
- HTTP carries no plaintext credential, vault name, logical path, token, note
  metadata, or note content.
- Bootstrap is public and tightly bounded. Every sensitive request occurs after
  a pinned Noise handshake and is carried in a binary encrypted envelope.
- The server operates only on opaque vault, commit, and blob identifiers.
- All integers are unsigned and bounded before allocation.
- Binary payloads use the deterministic CBOR profile in `format.md`.

## Fixed routes

| Method | Route | Body | Authentication |
| --- | --- | --- | --- |
| `GET` | `/v1/bootstrap` | none | Public, bounded and concurrency limited |
| `POST` | `/v1/handshake` | one bounded Noise NK initiator message | Public, rate limited |
| `POST` | `/v1/envelope` | session handle plus Noise transport ciphertext | Established session |

There are no credential-bearing query parameters or user-controlled route
segments. Servers disable HTTP access logs for request bodies and do not log
ordinary headers.

## Bootstrap

The deterministic response contains:

```text
protocol_version
instance_id
noise_suite
server_static_public_key
server_fingerprint
maximum_handshake_bytes
maximum_transport_bytes
```

The client computes SHA-256 over `server_static_public_key` and compares the
display form `SHA256:<uppercase base32 without padding>` with the value entered
by the user. It also checks the response's fingerprint for internal
consistency. Any mismatch is fatal.

## Handshake

The only version-1 suite is:

```text
Noise_NK_25519_ChaChaPoly_BLAKE2s
```

The initiator is preconfigured with the responder static public key recovered
from the pinned bootstrap response. NK exchanges:

```text
<- s
...
-> e, es
<- e, ee
```

The Noise prologue is deterministic CBOR:

```text
["learning-loop", 1, instance_id, "Noise_NK_25519_ChaChaPoly_BLAKE2s"]
```

The final handshake response also assigns a random 256-bit session handle. The handle is an
opaque lookup key, not an authorization bearer token; accepted requests still
require valid ordered Noise transport ciphertext. Sessions expire after a
fixed short lifetime and have a hard message lifetime.

## Encrypted authentication

The encrypted payload of the final responder handshake message is:

```text
auth_challenge {
  session_handle
  authentication_salt
  argon2_parameters
  random_challenge
  session_id
}
```

Both peers obtain `handshake_hash` from the completed Noise state; it is not
duplicated inside the payload whose ciphertext contributes to that hash.

The client derives `server_auth_key` with Argon2id and returns:

```text
HMAC-SHA256(
  server_auth_key,
  "learning-loop/server-auth/v1" ||
  handshake_hash ||
  random_challenge ||
  session_id
)
```

An existing device also signs the domain-separated challenge with Ed25519. A
new device may request registration only after the password proof succeeds.
Authentication failures use a single error class, bounded exponential delay,
and no account or vault oracle.

After a valid password proof, the encrypted `authenticated` response returns
the persistent random `vault_id`. It is not present in bootstrap and is never
exposed before authentication.

## Transport envelope

The HTTP body is:

```text
magic[4] = "LLP1"
session_handle[32]
record_stream_length: u32 big endian
noise_record_stream[record_stream_length]
```

The record stream contains one or more records:

```text
record_ciphertext_length: u16 big endian
noise_transport_ciphertext[record_ciphertext_length]
```

Each Noise ciphertext is at most 65,535 bytes, including its authentication
tag. Application messages larger than one Noise message are split into
60-KiB plaintext records and authenticated independently under consecutive
Noise transport nonces. The receiver rejects empty, truncated, trailing, or
oversized record streams and discards that session after any record failure.

The decrypted deterministic CBOR application message is:

```text
[protocol_version, sequence, request]
```

Requests for one session are serialized. `sequence` starts at zero for the
first encrypted authentication request and must increase by exactly one in
each direction. The
application sequence is checked in addition to the Noise transport nonce so a
state-restoration bug fails closed.

## Operations

The authenticated object service implements:

```text
authenticate
register_device
list_devices
revoke_device
put_blob_begin
put_blob_chunk
put_blob_commit
get_blob
ping
```

Phase 2 adds:

```text
put_commit
get_commit
get_heads
get_changes
```

Blob begin is naturally idempotent by device, expected size, and BLAKE3 hash.
Upload chunks carry an exact expected offset; reconnecting clients repeat begin
to learn the durable offset. Commit-graph mutations added in phase 2 carry
content-derived commit IDs and return the original result for exact duplicate
records.

## Commit acceptance

Within one SQLite transaction the server:

1. confirms the session and device remain authorized;
2. enforces size and sequence limits;
3. recomputes the deterministic commit ID;
4. verifies the authenticated device's Ed25519 signature;
5. checks every parent exists, unless the commit is the single first root;
6. requires the device sequence to be the next value or an exact idempotent
   duplicate;
7. inserts the immutable commit;
8. removes its parents from the head set and adds the new commit;
9. records the idempotent result.

The server never decrypts the commit body or interprets file operations.
Change batches are bounded, ordered by graph generation and then commit ID, and
therefore always return parents before children.

## Reconnect and resumption

Noise sessions are never serialized to disk. A reconnect performs a fresh
handshake and authentication. Resumable blob upload state is keyed by an
encrypted-request upload ID and persists only bounded offsets and ciphertext
hash state. Client pending operations persist before I/O, so Android process
death resumes by querying the committed offset or restarting an idempotent
upload.

## Error model

Before authentication errors reveal only:

```text
unsupported_protocol
request_too_large
rate_limited
authentication_failed
temporarily_unavailable
```

After authentication, errors use stable numeric codes and bounded,
non-reflective text. Untrusted values and cryptographic details are not echoed.
