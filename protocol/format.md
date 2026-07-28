# Deterministic format profile

## Encoding

Learning Loop binary structures use deterministic CBOR derived from RFC 8949
section 4.2.1 with these additional restrictions:

- definite-length arrays, byte strings, text strings, and maps only;
- unsigned integers only unless a schema explicitly permits a signed value;
- no floating point, tags, `null`, or `undefined`;
- map keys are unsigned small integers defined by the schema;
- keys are strictly increasing and duplicates are rejected;
- UTF-8 text must be valid and NFC;
- decoders enforce maximum nesting, collection counts, string sizes, and total
  bytes before allocation;
- a decoded value is accepted for hashing or signing only if re-encoding it
  produces the exact original bytes.

Protocol schemas use integer keys so Rust and WebAssembly implementations do not
depend on host object-key ordering.

## Identifiers

- `instance_id`, `vault_id`, `object_id`, `device_id`, `request_id`, and
  idempotency keys are 16-byte UUIDs.
- New stable object IDs are UUIDv7 per RFC 9562.
- `blob_id`, `commit_id`, `ciphertext_hash`, and manifest tree hashes are
  32-byte BLAKE3 digests.
- Ed25519 public keys and signatures have their standard fixed byte lengths.
- A server fingerprint is SHA-256 of the 32-byte Noise static public key,
  displayed as uppercase unpadded base32 with a `SHA256:` prefix.

IDs are opaque. Clients must not derive plaintext paths or titles into an
identifier.

## Object envelope

The encrypted object envelope is a deterministic CBOR map:

| Key | Field | Type |
| --- | --- | --- |
| 0 | protocol version | unsigned integer |
| 1 | vault ID | 16-byte string |
| 2 | object ID | 16-byte string |
| 3 | revision | unsigned integer |
| 4 | object type | unsigned enum |
| 5 | payload nonce | 24-byte string |
| 6 | wrapped-DEK nonce | 24-byte string |
| 7 | wrapped DEK | byte string |
| 8 | ciphertext | byte string |

AAD is the deterministic array:

```text
[protocol_version, vault_id, object_id, revision, object_type, cipher_suite]
```

The payload is encrypted with a fresh random DEK using
XChaCha20-Poly1305. The DEK is independently wrapped with the VMK-derived key
for its object type. Both nonces must be fresh random 192-bit values.

## Commit envelope

The unsigned outer commit map contains:

| Key | Field |
| --- | --- |
| 0 | protocol version |
| 1 | vault ID |
| 2 | parent commit ID array, lexicographically sorted and unique |
| 3 | device ID |
| 4 | device sequence |
| 5 | ciphertext body size |
| 6 | ciphertext body BLAKE3 |
| 7 | encrypted commit body |

The `commit_id` is:

```text
BLAKE3("learning-loop/commit-id/v1" || deterministic_unsigned_commit)
```

The signature is Ed25519 over:

```text
"learning-loop/commit-signature/v1" || commit_id
```

The transmitted record contains the unsigned envelope, commit ID, and
signature. A decoder recomputes both the encoding and ID before verifying the
signature.

## Encrypted commit body

The client-only body contains:

```text
logical_timestamp
operations
manifest_root
object mappings
encrypted logical paths
plaintext canonical hashes
merge metadata
conflict metadata
```

`logical_timestamp` is a Lamport value, not wall-clock authority. Operations
use stable object IDs and explicit kinds:

```text
create
modify
rename
delete_tombstone
merge
```

## Text canonicalization

For synchronized text bytes only:

1. validate UTF-8;
2. remove one leading UTF-8 BOM if present;
3. replace CRLF and remaining CR with LF;
4. preserve every other byte, including indentation, spaces, YAML key order,
   code blocks, headings, and trailing blank lines.

Binary objects are never text-normalized.

## Portable paths

Logical paths:

- are relative and use `/`;
- contain non-empty NFC segments;
- reject `.` and `..`;
- reject NUL, Unicode control characters, `< > : " \ | ? *`;
- reject a segment ending in ASCII space or period;
- reject `CON`, `PRN`, `AUX`, `NUL`, `COM1` through `COM9`, and `LPT1`
  through `LPT9`, case-insensitively and even with an extension;
- are limited to 255 UTF-8 bytes per segment and 1024 UTF-8 bytes total.

The collision key normalizes every segment to NFC, applies Unicode default full
case folding, and joins with `/`. It is for comparison only and is never used
as a replacement filename. Illegal or colliding paths require explicit user
repair and a signed rename commit.

The shared vectors in `protocol/test-vectors/portable-paths.json` are normative
for Rust and TypeScript/WASM tests.
