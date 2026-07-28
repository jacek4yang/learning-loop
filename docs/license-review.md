# License review

Review date: 2026-07-28

Learning Loop is Apache-2.0. This file is the source-use ledger for researched
projects and implementation dependencies. An entry marked "reference only" does
not authorize copying source.

| Project | Upstream license | Intended use | Source copied | Obligations / decision |
| --- | --- | --- | --- | --- |
| Obsidian Sample Plugin | 0BSD | API/build reference | No | Use published API patterns; no attribution required for copied code because none is copied. |
| Obsidian API | MIT | npm runtime/types dependency | No | Lock dependency; include MIT notice in generated third-party notices. |
| Self-hosted LiveSync | MIT | architecture reference | No | No source use. |
| Remotely Save free tree | Apache-2.0 | architecture reference | No | No source use. |
| Remotely Save `pro` | PolyForm Strict 1.0.0 | prohibited | No | Do not inspect, copy, link, or derive from this tree. |
| Obsidian Spaced Repetition | MIT | UX/feature reference | No | Scheduler is independently specified and tested. |
| JSON Canvas | MIT | file-format implementation | No | Implement the public specification; include MIT notice if upstream material is ever copied. |
| Noise specification | Public domain | protocol specification | No | Use the named standard. |
| `snow` | MIT OR Apache-2.0 | Cargo dependency | No | Select Apache-2.0 where permitted; retain notices in SBOM/third-party report. |
| RustCrypto crates | MIT OR Apache-2.0 | Cargo dependencies | No | Select Apache-2.0 where permitted; retain notices. |
| BLAKE3 | CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception | Cargo dependency | No | Select Apache-2.0; retain notices. |
| `minicbor` | BlueOak-1.0.0 | deterministic bounded CBOR dependency | No | Permissive OSI-approved license; retain its notice in generated third-party material. |
| `ring` and `untrusted` | Apache-2.0 AND ISC / ISC | transitive `snow` dependencies | No | Both terms are permissive; retain required notices. |
| Dalek cryptography and `subtle` | BSD-3-Clause | X25519, Ed25519, and constant-time transitive/direct dependencies | No | Permissive BSD terms; retain copyright and disclaimer notices. |
| `arrayref` | BSD-2-Clause | transitive BLAKE3 dependency | No | Permissive BSD terms; retain copyright and disclaimer notices. |
| Git | GPL-2.0-only | conceptual documentation only | No | No Git code, executable, library, or repository mechanism is used by vault sync. |

## Policy

- GPL, AGPL, SSPL, BSL, PolyForm, Commons Clause, unlicensed, or ambiguous
  source is not introduced without a documented project-wide compatibility
  decision.
- Package metadata is necessary but not sufficient evidence. CI runs
  `cargo deny check`, `cargo audit`, and package-manager auditing against the
  resolved lockfiles.
- Release generation produces an SBOM and third-party notice inventory from the
  actual dependency graph.
- Any future copied source must identify the exact upstream commit, file, lines,
  modifications, license, notice, and distribution obligations here before it
  is merged.

## Current source reuse

There is no copied third-party source code in the repository. All researched
projects are reference-only; third-party implementation enters only through
declared package dependencies.
