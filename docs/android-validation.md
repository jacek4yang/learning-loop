# Android foreground synchronization validation

## Implemented lifecycle

The Android-compatible plugin build uses only Obsidian APIs and browser
facilities:

- `requestUrl()` for all three fixed binary HTTP routes;
- `Platform.isAndroidApp` for the bounded mobile Argon2id calibration policy;
- IndexedDB for sync state and staged ciphertext;
- a single-column foreground panel with 48-pixel minimum action targets;
- explicit **Waiting to sync**, **Syncing now**, and **Synced** states;
- a visibility-change trigger that resumes work only after Obsidian returns to
  the foreground;
- exact ciphertext and signed-commit retry after process death.

The client password remains required after a fresh Obsidian process. Unlocking
then immediately runs the persisted reconciliation/upload state machine.

## Required manual procedure

Use a disposable Vault and synthetic files only.

1. Install `manifest.json`, `main.js`, `core.wasm`, and `styles.css` manually in
   the Vault's configured plugin directory.
2. Configure the DDNS hostname, port, out-of-band server fingerprint, two
   distinct passwords, and device name.
3. Verify bootstrap/handshake/envelope traffic over the intended plain HTTP
   arbitrary port and confirm an incorrect fingerprint has no bypass.
4. Start a multi-chunk attachment upload, force-stop Obsidian after at least one
   chunk, reopen, unlock, and confirm the server resumes at the durable offset.
5. Repeat with a lost commit response and confirm the exact signed commit is
   accepted idempotently.
6. Modify the same Markdown file concurrently on desktop and Android; verify a
   clean merge or two preserved versions plus a conflict record.
7. Compare canonical logical contents after CRLF/LF, Unicode NFC/NFD, rename,
   tombstone, and binary cases.
8. Record Obsidian/Android versions, physical device or emulator identity,
   server build commit, timestamps, and redacted evidence.

## Evidence

| Environment | Foreground UI | Binary `requestUrl` | Force-stop resume | Cross-device consistency |
| --- | --- | --- | --- | --- |
| Automated TypeScript/Rust simulation on Windows | Pass | Native protocol and Node loopback pass | Pass by injected lost chunk/commit responses | Canonical/merge tests pass |
| Android emulator | Not available in current environment | Not run | Not run | Not run |
| Android physical device | Not attached | Not run | Not run | Not run |

The automated row proves the deterministic state machine, not Android WebView
or Obsidian transport behavior. Both real Android rows remain release blockers
and are intentionally not marked as passing.
