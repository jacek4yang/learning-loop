# Changelog

All notable changes are documented here. Learning Loop follows semantic
versioning for the server protocol implementation and Obsidian plugin package.

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
