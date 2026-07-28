# Learning Loop

Learning Loop is a self-hosted, end-to-end encrypted synchronization service and
cross-platform Obsidian learning-workflow plugin. The repository is a monorepo
for the Rust server, shared protocol and cryptography crates, a portable
TypeScript plugin, and a WebAssembly client core.

The repository currently contains the authenticated Rust object service,
encrypted commit DAG, native/WASM client core, and the v0.3 desktop Obsidian
synchronization implementation. It remains a development build until the
cross-platform evidence matrix and v1.0 release gates are complete; do not use
it as the only copy of production data.

## Security boundary

The server and network protocol are designed to handle ciphertext only. After a
user unlocks the plugin, Obsidian must be able to read the local Markdown
plaintext so native editing, search, and links continue to work. Users must
protect local data with full-disk encryption such as BitLocker, FileVault, LUKS,
or Android device encryption and a strong screen lock.

The plugin will not include AI, retain AI conversations, collect telemetry, or
send note content to third parties.

## Development

Install the pinned toolchains, then run:

```text
cargo test --workspace --all-features
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The plugin production build creates ignored `plugin/main.js` and
`plugin/core.wasm`; release packaging adds these to the source-controlled
manifest and stylesheet. See [docs/synchronization.md](docs/synchronization.md)
for the sync state machine,
[docs/learning-workflows.md](docs/learning-workflows.md) for the Markdown-first
learning model, [docs/test-matrix.md](docs/test-matrix.md) for adversarial
coverage and platform evidence, [CONTRIBUTING.md](CONTRIBUTING.md) for development rules, and
[SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
