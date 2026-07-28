# Contributing

## Ground rules

- Use Conventional Commits.
- Keep server, protocol, cryptography, canonicalization, versioning, UI, and
  learning-domain code in separate modules.
- Never commit passwords, private keys, tokens, real server addresses, test
  credentials, runtime databases, vault contents, or build artifacts.
- Do not introduce Git, libgit2, JGit, WebDAV, or third-party synchronization
  services into the vault synchronization implementation.
- Do not copy unlicensed code. Document every source-level reuse and its license
  obligations in `docs/license-review.md`.
- Prefer mature cryptographic libraries and never implement cryptographic
  primitives or the Noise state machine from scratch.

## Required checks

Rust changes must pass formatting, Clippy with warnings denied, workspace tests,
dependency auditing, and license-policy checks. TypeScript changes must pass
linting, type checking, Vitest, the production build, and dependency auditing.
Protocol changes require shared test-vector updates.

Each independently verifiable phase should end with passing checks and a clean
working tree.

## Development data

Use only synthetic fixtures. The local Obsidian development vault and server
data directory are ignored by Git. Generated `main.js`, WebAssembly binaries,
server binaries, and release archives belong only in release packages.
