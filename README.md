# Learning Loop

Learning Loop is a self-hosted, end-to-end encrypted synchronization service and
cross-platform Obsidian learning-workflow plugin. The repository is a monorepo
for the Rust server, shared protocol and cryptography crates, a portable
TypeScript plugin, and a WebAssembly client core.

Version 1.1 contains the authenticated Rust object service, encrypted commit
DAG, native/WASM client core, desktop/Android-compatible synchronization, and
Markdown-first learning workflows, a focused Learning Loop workspace, visual
knowledge tree, and a locally generated copyable AI-learning context. Keep an
independent Vault backup and read the validation report before relying on it.

## Security boundary

The server and network protocol are designed to handle ciphertext only. After a
user unlocks the plugin, Obsidian must be able to read the local Markdown
plaintext so native editing, search, and links continue to work. Users must
protect local data with full-disk encryption such as BitLocker, FileVault, LUKS,
or Android device encryption and a strong screen lock.

The plugin does not contact an AI service, retain AI conversations, collect
telemetry, or send note content to third parties. Its **Copy for AI** action
only places a locally generated, credential-filtered Markdown context on the
system clipboard; the user chooses whether and where to paste it.

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
learning model,
[the illustrated Chinese handbook](docs/learning-loop-handbook.zh-CN.html) for
the complete clickable workflow and Markdown guide,
[docs/test-matrix.md](docs/test-matrix.md) for adversarial
coverage and platform evidence,
[docs/installation.md](docs/installation.md) for installation and recovery,
[docs/operations.md](docs/operations.md) for server administration,
[docs/release-validation.md](docs/release-validation.md) for passed and unrun
release checks, [CONTRIBUTING.md](CONTRIBUTING.md) for development rules, and
[SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
