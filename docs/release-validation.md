# Release validation report

## Automated evidence

Validation on 2026-07-28 used Rust 1.95.0, Node 26.1.0, pnpm 11.9.0,
wasm-pack, cargo-audit, cargo-deny, and cargo-mutants 27.1.0.

| Gate | Result |
| --- | --- |
| `cargo fmt --all -- --check` | passed |
| Clippy, all workspace targets/features, warnings denied | passed |
| Rust workspace test suite | 63 passed |
| All five fuzz binaries compile | passed on Windows MSVC |
| Targeted key-module mutation run | 29 caught, 2 unviable, 0 survived |
| RustSec advisory audit | no known vulnerability |
| cargo-deny advisories/licenses/sources | passed; duplicate versions are warnings |
| TypeScript typecheck and ESLint | passed |
| Vitest and fast-check | 45 passed |
| Production WebAssembly/plugin build | passed |
| pnpm high-severity audit | no known vulnerability |
| Windows x86-64 server release build/package | passed; archives extracted and every internal SHA-256 verified |
| Deterministic plugin package rebuild | passed; byte-identical archive SHA-256 |

The test inventory and fault matrix are in [test-matrix.md](test-matrix.md).
The CI workflows repeat these gates, run bounded Linux nightly fuzz sessions,
build all six server targets natively, generate CycloneDX SBOMs, package the
plugin, produce SHA-256 manifests, and attest release provenance.

## Real-host status

These claims have **not** been fabricated:

| Environment | Status |
| --- | --- |
| Windows development host, unit/integration/build tests | passed |
| Windows Obsidian desktop, installed package, two real Vaults | not run; Obsidian is unavailable on this host |
| Linux Obsidian desktop | not run; no Linux host is connected |
| macOS Intel and Apple silicon Obsidian desktop | not run; no macOS host is connected |
| Android emulator and physical device | not run; Android SDK/emulator/device is unavailable |
| Real DDNS/NAT network interruption and recovery | not run; no deployment endpoint was supplied |
| Disk-full and externally held SQLite-lock injection | not run on a disposable host |

The portable filesystem profiles, transport probe, black-box TCP server,
process-loss state, restart, corrupt storage, large binary, multi-device DAG,
and adversarial security behavior are automated models. They are not a
substitute for the real-host rows above.

## Release decision

The repository and packages are suitable for a public evaluation release.
Version 1.0.0 is not yet qualified as the only synchronization path for
important data: complete the unrun real-host rows, retain independent Vault
backups, and record any observed Obsidian/mobile lifecycle differences before
making that production claim.
