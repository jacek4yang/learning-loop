# Changelog

All notable changes are documented here. Learning Loop follows semantic
versioning for the server protocol implementation and Obsidian plugin package.

## 1.1.0 - 2026-07-29

- Replace browser-unsupported Rust `Instant` and `SystemTime` calls with
  WebAssembly-compatible monotonic and wall clocks.
- Generate UUIDv7 identifiers from an explicitly supplied browser-compatible
  timestamp instead of `Uuid::now_v7`.
- Add a Node-hosted WebAssembly runtime smoke test that creates a vault,
  generates and encrypts a device identity, then unlocks and restores it.
- Keep newly written Learning Loop properties available until Obsidian's
  asynchronous metadata cache catches up, so topic outlines create their nodes
  reliably on the first attempt.
- Add a reversible focused workspace that hides unrelated Obsidian ribbon and
  status-bar actions while keeping Learning Loop's encrypted synchronization,
  learning tools, and current task visible.
- Add a clickable visual knowledge tree with topic progress, current-node
  highlighting, verification and confidence indicators, filtering, and direct
  note navigation.
- Add a unified creation center and consistent card-based Chinese forms for
  topics, nodes, review cards, English terms, papers, and technical records.
- Add one-click generation of a structured AI learning context, including a
  safe topic tree, current note, related summaries, suggested tutoring flow,
  and automatic omission of content that resembles credentials.
- Add a standalone illustrated Chinese HTML handbook covering the complete
  workflow, Markdown usage, English learning, programming practice, paper
  reading, cross-domain synthesis, review, synchronization, and recovery.

## 1.0.3 - 2026-07-29

- Distinguish an uninitialized server from one that already contains an
  encrypted synchronization space during the non-mutating connection test.
- Make first-device setup register the device before publishing the encrypted
  vault envelope, avoiding a password-wrapped half-initialized server when
  registration fails.
- Explain client-password mismatches and every first-setup phase in Chinese
  instead of falling back to a generic incomplete-operation message.
- Keep the setup action bar in normal document flow so it no longer overlays
  or clips the final configuration fields.

## 1.0.2 - 2026-07-29

- Add a non-mutating **测试连接** action to the encrypted synchronization
  setup window.
- Verify server reachability, the pinned fingerprint, and the server access
  password without registering a device, saving new input, or starting
  synchronization.
- Show an inline Chinese diagnostic for unreachable servers, fingerprint
  mismatches, authentication failures, and successful connections.

## 1.0.1 - 2026-07-29

- Save first-run server settings and the server password before attempting the
  network connection, so a temporarily unreachable server no longer erases the
  setup form.
- Open a Chinese client-password unlock dialog on startup after configuration,
  and route Sync now through setup or unlock instead of repeating locked
  notices.
- Add a polished right sidebar for synchronization and common learning
  actions; all actions remain available as Obsidian commands for custom
  hotkeys.
- Translate user-facing setup, learning, status, and error messages into
  Chinese and provide actionable connection/authentication diagnostics.
- Hide internal `ll_*` properties and the duplicate inline title from normal
  Learning Loop note views while preserving stable metadata in Markdown.

## 1.0.0 - 2026-07-28

- Add the bounded three-route Noise NK server with persistent identity,
  server-password authentication, Ed25519 devices, resumable opaque blobs,
  SQLite metadata, revocation, and encrypted commit DAG storage.
- Add the Rust and WebAssembly end-to-end encryption core with a random vault
  master key, Argon2id password wrapping, XChaCha20-Poly1305 object envelopes,
  deterministic CBOR, signed commits, manifests, and portable paths.
- Add the desktop and Android-compatible Obsidian plugin with pinned transport,
  crash-safe push/pull, conservative conflict preservation, background desktop
  reconciliation, and foreground mobile synchronization.
- Add Markdown-first topic, knowledge-node, English, paper, operations,
  evidence, review, dashboard, and rebuildable Canvas workflows.
- Add property, fuzz, mutation, cross-language limit, concurrency, large-file,
  fault-injection, security, and black-box service tests.
- Add six native server build targets, an architecture-independent plugin
  package, CycloneDX SBOM generation, SHA-256 manifests, and provenance-aware
  release automation.
