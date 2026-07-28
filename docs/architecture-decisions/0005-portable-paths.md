# ADR 0005: Strict portable paths and canonical text

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

NTFS, case-sensitive and insensitive APFS, ext4, Android storage, and Unicode
normalization differ. Accepting the union of host behaviors risks silent
overwrite. Treating `mtime` or OS metadata as truth creates meaningless
conflicts.

## Decision

Use the strict `PortablePath` profile in `protocol/format.md`. Rust is the
authority and is compiled to WebAssembly for the plugin. Reject illegal and
colliding paths without renaming. Offer a deterministic safe-name suggestion,
but apply it only after user confirmation through a signed rename commit.

Canonicalize synchronized text only by removing a leading UTF-8 BOM and mapping
CRLF/CR to LF. Do not change user formatting or YAML ordering. Exclude `mtime`,
`ctime`, permission bits, UID/GID, ACL, executable, hidden, and creation-time
metadata from the replicated model.

## Consequences

- Some names accepted by one local filesystem cannot synchronize until changed.
- Case and canonical-equivalence collisions are found before writes.
- Line-ending-only differences do not produce commits.
- Shared JSON vectors and property tests prevent Rust/TypeScript divergence.
