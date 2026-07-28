# Phase 0 research

Research date: 2026-07-28

This review records design evidence, not code provenance. No source code from the
projects below has been copied into Learning Loop. API and file-format behavior
is implemented independently from public specifications and type definitions.

## Obsidian Sample Plugin and API

- **Project:** Obsidian Sample Plugin and Obsidian API
- **Repositories:** <https://github.com/obsidianmd/obsidian-sample-plugin> and
  <https://github.com/obsidianmd/obsidian-api>
- **License:** 0BSD for the sample, MIT for the API type definitions.
- **Designs worth using:** one bundled entry point; `manifest.json`;
  `isDesktopOnly=false`; lifecycle-managed events; no default hotkeys; release
  assets consisting of `manifest.json`, `main.js`, and `styles.css`.
- **Known constraints:** mobile uses `CapacitorAdapter`, not
  `FileSystemAdapter`; plugins must avoid Node and Electron APIs on mobile;
  background edits should use `Vault.process()` and frontmatter edits should use
  `FileManager.processFrontMatter()`.
- **Source use:** none. Learning Loop consumes the published `obsidian` package
  only for types and runtime API imports.

The official plugin review checklist explicitly recommends `requestUrl()` over
`fetch` or Axios, `Vault.configDir` over a hard-coded `.obsidian`, `Platform`
over `process.platform`, and `workspace.onLayoutReady()` for startup UI:
<https://docs.obsidian.md/oo/plugin>.

## Self-hosted LiveSync

- **Project:** Self-hosted LiveSync
- **Repository:** <https://github.com/vrtmrz/obsidian-livesync>
- **License:** MIT.
- **Designs worth using:** resumable queues, explicit progress state,
  reconciliation after missed mobile events, conflict preservation, and a
  recovery path when local sync state is corrupt.
- **Known constraints:** its architecture relies on CouchDB, object storage, or
  WebRTC and is therefore not reusable as Learning Loop's server design. Its
  breadth also demonstrates why configuration synchronization must not be
  allowed to overwrite the sync engine's own safety state silently.
- **Source use:** none.

## Remotely Save

- **Project:** Remotely Save
- **Repository:** <https://github.com/remotely-save/remotely-save>
- **License:** `src`, `tests`, `docs`, and `assets` are Apache-2.0; `pro` is
  PolyForm Strict 1.0.0 source-available code.
- **Designs worth using:** explicit mobile support, manual release installation,
  large-file handling, scheduled reconciliation, and preserving a conflicting
  binary rather than overwriting it.
- **Known constraints:** it delegates storage to S3/WebDAV/cloud APIs, persists
  sensitive provider settings, and documents mobile performance problems for
  files at or above 50 MB. Those choices do not satisfy Learning Loop's
  dedicated opaque server or secret-storage requirements.
- **Source use:** none. The `pro` directory is prohibited from inspection,
  copying, or derivation.

## Obsidian Spaced Repetition

- **Project:** Obsidian Spaced Repetition
- **Repository:** <https://github.com/st3v3nmw/obsidian-spaced-repetition>
- **License:** MIT.
- **Designs worth using:** due queues, note-level and card-level review,
  deterministic scheduling tests, and user-visible ratings.
- **Known constraints:** its feature set and persisted schema do not match
  Learning Loop's three ratings or Markdown-Properties-as-source-of-truth rule.
- **Source use:** none. Learning Loop uses an independently specified scheduler.

## JSON Canvas

- **Project:** JSON Canvas
- **Repository:** <https://github.com/obsidianmd/jsoncanvas>
- **Specification:** <https://jsoncanvas.org/spec/1.0/>
- **License:** MIT.
- **Designs worth using:** open `.canvas` files with stable node IDs, integer
  geometry, ordered node arrays, and explicit edges.
- **Known constraints:** the format defines storage, not deterministic layout or
  conflict semantics. User-authored canvases cannot be treated as generated
  caches.
- **Source use:** no source. The public format is implemented independently.

## Noise Protocol and `snow`

- **Specification:** <https://noiseprotocol.org/noise.html>
- **Implementation:** <https://github.com/mcginty/snow>
- **License:** the Noise specification is public domain; `snow` is
  MIT OR Apache-2.0.
- **Designs worth using:** a named, fixed handshake suite; a pinned responder
  static key; ephemeral keys from both peers; transcript-bound prologue; split
  transport states; bounded handshake messages.
- **Known constraints:** `snow` states that it has not received a formal audit.
  Noise authenticates keys, not application authorization; password challenge,
  device registration, replay policy, message limits, and logging discipline
  remain application responsibilities.
- **Source use:** dependency use only; no vendored or copied source.

The selected initial suite is
`Noise_NK_25519_ChaChaPoly_BLAKE2s`. In NK the initiator already knows the
responder static key, while both parties contribute ephemeral keys. The prologue
binds the Learning Loop protocol version, instance ID, and exact suite. Device
Ed25519 authentication and the server-password challenge occur inside the
resulting encrypted channel.

## Argon2id, AEAD, HKDF, and BLAKE3

- **Projects:** RustCrypto `password-hashes`, `AEADs`, `KDFs`, and the official
  BLAKE3 implementation.
- **Repositories:** <https://github.com/RustCrypto/password-hashes>,
  <https://github.com/RustCrypto/AEADs>,
  <https://github.com/RustCrypto/KDFs>, and
  <https://github.com/BLAKE3-team/BLAKE3>.
- **License:** RustCrypto crates are generally MIT OR Apache-2.0; BLAKE3 is
  CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception. Exact resolved
  package licenses are enforced by `cargo-deny`.
- **Designs worth using:** Argon2id PHC parameters, XChaCha20-Poly1305 with a
  192-bit random nonce, HKDF-SHA-256 domain separation, zeroizing key buffers,
  and BLAKE3 content identifiers.
- **Known constraints:** Argon2 parameters must be calibrated and capped on
  Android; AEAD does not prevent nonce reuse by itself; BLAKE3 is not a password
  hash; cryptographic libraries do not define the envelope or recovery model.
- **Source use:** dependency use only.

## Git object and merge concepts

- **Project:** Git documentation
- **Documentation:** <https://git-scm.com/docs/user-manual>,
  <https://git-scm.com/docs/git-commit-tree>, and
  <https://git-scm.com/book/en/v2/Git-Branching-Basic-Branching-and-Merging>
- **License:** documentation is used as conceptual reference only.
- **Designs worth using:** immutable content-addressed objects, zero/one/multiple
  commit parents, reachability, common ancestors, head sets, and three-way
  merge.
- **Known constraints:** Git does not record rename identity as a first-class
  invariant and exposes filenames and content. Learning Loop therefore uses
  stable UUIDv7 object IDs, encrypted manifests, encrypted paths, signed commit
  envelopes, and explicit rename/tombstone operations.
- **Source use:** none. The sync implementation is forbidden from invoking Git
  commands, repositories, libgit2, or JGit.

## Portable path references

- **Unicode normalization:** Unicode Standard Annex #15,
  <https://unicode.org/reports/tr15/>.
- **Unicode case folding:** Unicode default case folding,
  <https://www.unicode.org/versions/latest/core-spec/chapter-3/>.
- **Windows names:** Microsoft file naming rules,
  <https://learn.microsoft.com/windows/win32/fileio/naming-a-file>.
- **APFS:** Apple documents that APFS is case-insensitive by default but can be
  case-sensitive, and preserves names while comparing normalized forms:
  <https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/FAQ/FAQ.html>.

The portable representation is stricter than any one host filesystem. It uses
NFC and Unicode default case folding for collision detection, rejects Windows
reserved syntax, and never silently repairs a colliding path.

## Versioned binary format references

- **Deterministic CBOR:** RFC 8949,
  <https://www.rfc-editor.org/rfc/rfc8949.html>.
- **UUIDv7:** RFC 9562,
  <https://www.rfc-editor.org/rfc/rfc9562.html>.

Learning Loop uses a deliberately small deterministic CBOR profile and UUIDv7
for stable object identity. Decoders reject non-deterministic encodings before
hashing or signature verification.

## Research conclusions

1. Markdown and Properties remain the learning system's source of truth.
2. A Rust core compiled to WebAssembly is the authority for cryptography,
   deterministic encoding, portable paths, and version graph operations.
3. The server is a dedicated ciphertext object service backed by SQLite and an
   append-only object directory; no existing sync backend is embedded.
4. A fixed Noise NK suite plus out-of-band fingerprint pinning fits the
   no-public-certificate constraint.
5. Cleartext HTTP transport through Obsidian `requestUrl()` remains a release
   gate on Windows, Linux, and Android hardware; API documentation alone is not
   recorded as an executed platform test.
6. Existing project source is not copied. Dependencies must pass automated
   license and advisory checks.
