# Adversarial test matrix

This matrix records executable evidence separately from platform claims. A
checked row means the named automated test ran; it does not claim that a host
operating system or Android device was used.

## Automated suites

| Area | Executable evidence | Coverage |
| --- | --- | --- |
| Protocol | `ll-protocol` unit, property, and `protocol_decoders` fuzz targets | framing, illegal/truncated/oversized lengths, deterministic CBOR, arbitrary corrupt input |
| Commit formats | `ll-versioning` unit tests and `commit_decoders` fuzz target | corrupt/tampered record, exact encoding, limits |
| Commit graph | `adversarial_graph` and server black-box test | continuous, 2-device and 3-device forks, multi-parent merge, ancestor, recovery, duplicate, out-of-order, missing parent, forged signature, revoked device |
| Paths | portable vectors, `filesystem_matrix`, properties, and `portable_path` fuzz target | CJK, emoji, spaces, multi-dot, depth, NFC/NFD, case, reserved names, suffixes, traversal, illegal characters, byte limits |
| Contents | `filesystem_matrix` and reconciliation suite | UTF-8, BOM, LF/CRLF/CR, empty, no final newline, code fence, multiline YAML, Canvas, Base, PDF/image/audio, binary over 100 MiB |
| Ciphertext | crypto tests and `encrypted_manifest` fuzz target | corrupt ciphertext, wrong password, AAD/hash/nonce changes, manifest/commit decode |
| Chunking | server storage tests, push crash tests, and `chunk_reassembly` fuzz target | offset mismatch, duplicate/out-of-order data, crash tail, lost response, exact retry |
| Merge | pull tests plus `adversarial-merge.test.ts` with fast-check | same/different paragraph, delete-modify, same-path create, insertion, binary preservation, no conflict markers |
| Client state | state, engine, pull, and reconciliation tests | process-loss resume, missing staged data, lost commit response, collisions, corrupt state |
| Security | server black-box and crypto tests | fingerprint substitution, unauthenticated upload, password failure/backoff, replay, request/body caps, signature forgery, commit/blob tamper, revocation |
| Learning | learning unit and in-memory Obsidian integration tests | schemas, outlines, cards, schedules, rebuildable Canvas, secret guard, manual-map non-overwrite |

## Filesystem profiles

Portable logical paths use a stricter shared subset, so the same vectors are
evaluated for Windows NTFS, default case-insensitive APFS, case-sensitive APFS,
Linux ext4, and Android storage. Case-folded or normalization-equivalent names
are rejected before publication on every profile. Actual host validation is
recorded below.

| Environment | Automated model | Real host run |
| --- | --- | --- |
| Windows NTFS | yes | pending final packaged-plugin validation |
| macOS APFS, case-insensitive | yes | not run; no macOS host available |
| macOS APFS, case-sensitive | yes | not run; no macOS host available |
| Linux ext4 | yes | not run; no Linux host available |
| Android app storage | yes | not run; no Android emulator/device available |

## Fault injection status

Automated: upload/download response loss, duplicate and out-of-order chunks,
server restart, client/process restart, temporary crash-tail repair, wrong
password, fingerprint/key substitution, replay, ciphertext/hash/signature
corruption, state-transform failure, and device revocation.

Not yet physically injected: disk-full filesystem, OS-level SQLite lock held by
an external process, Android force-stop, and real network interruption on each
target platform. These remain explicit release-validation items and must not be
reported as passed.
