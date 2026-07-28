# ADR 0001: Rust core is the cross-platform authority

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

Portable paths, deterministic encoding, cryptography, commit IDs, signatures,
and version-graph behavior must produce identical results on Rust servers,
desktop Obsidian, and Android Obsidian. Independent Rust and TypeScript
implementations would create a dangerous test-vector and upgrade burden.

## Decision

Use one monorepo. Native server components are Rust workspace crates. The
portable client authority is a Rust crate compiled to
`wasm32-unknown-unknown`. TypeScript owns Obsidian API integration, UI,
IndexedDB state, workflows, and orchestration, but invokes the WebAssembly core
for cryptography, deterministic binary formats, portable path decisions, and
commit-graph primitives.

The plugin remains `isDesktopOnly=false` and does not use Node, Electron, or
native SQLite. WebAssembly output is included only in release packages.

## Consequences

- Shared Rust tests and vectors cover both server and client algorithms.
- JavaScript glue and WebAssembly loading require explicit mobile testing.
- UI and Obsidian mocks remain TypeScript tests.
- No generated `main.js` or `.wasm` is committed as normal source.
