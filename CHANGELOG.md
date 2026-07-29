# Changelog

All notable changes are documented here. Learning Loop follows semantic
versioning for the server protocol implementation and Obsidian plugin package.

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
