# ADR 0004: Encrypted immutable commit DAG

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

Synchronization needs concurrent heads, common ancestors, durable renames,
tombstones, history, and three-way merges without exposing paths or content to
the server. Git provides useful concepts but cannot be part of vault sync.

## Decision

Implement an independent immutable object and commit graph:

- stable UUIDv7 object IDs survive rename;
- encrypted manifests map objects to encrypted paths and revisions;
- commits have zero, one, or multiple parent IDs;
- commit IDs hash a deterministic encrypted envelope with BLAKE3;
- devices sign commits with Ed25519;
- servers validate outer structure, parents, sequence, signature, and limits,
  then maintain an atomic head set;
- clients find common ancestors, decrypt manifests, perform three-way merges,
  create conflict copies, and publish merge commits.

No Git command, repository, object format, libgit2, or JGit is used.

## Consequences

- The server can validate graph integrity without seeing operations.
- Clients, not the server, bear merge complexity.
- A stable object ID distinguishes rename from delete-plus-create.
- New-device recovery downloads the complete reachable encrypted graph and
  reconstructs local state from manifests and canonical content hashes.
