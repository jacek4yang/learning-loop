# Learning Loop

Learning Loop is a self-hosted, end-to-end encrypted synchronization service and
cross-platform Obsidian learning-workflow plugin. The repository is a monorepo
for the Rust server, shared protocol and cryptography crates, a portable
TypeScript plugin, and a WebAssembly client core.

The project is under active development. No release is currently suitable for
protecting production data.

## Security boundary

The server and network protocol are designed to handle ciphertext only. After a
user unlocks the plugin, Obsidian must be able to read the local Markdown
plaintext so native editing, search, and links continue to work. Users must
protect local data with full-disk encryption such as BitLocker, FileVault, LUKS,
or Android device encryption and a strong screen lock.

The plugin will not include AI, retain AI conversations, collect telemetry, or
send note content to third parties.

## Repository status

Implementation, security documentation, reproducible tests, and installable
release packages will be added in independently verifiable phases. See
[CONTRIBUTING.md](CONTRIBUTING.md) for development rules and
[SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
