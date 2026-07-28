# Obsidian transport validation

The automated loopback verifies exact binary HTTP request/response behavior:

```text
pnpm test:transport
```

It does not substitute for running Obsidian's `requestUrl()` implementation.

## Manual procedure

1. Run `pnpm install` and `pnpm build`.
2. Run `node scripts/transport-spike-server.mjs` on a host reachable from the
   test device.
3. Copy `plugin/manifest.json`, generated `plugin/main.js`, and
   `plugin/styles.css` into
   `<development-vault>/<Vault.configDir>/plugins/learning-loop/`.
4. Enable the plugin. Do not use production credentials or a real vault.
5. Set **Transport test endpoint** to the test host's plain HTTP URL and fixed
   port. Never put a password or token in the URL.
6. Run **Learning Loop: Run transport compatibility check**.
7. Record Obsidian version, OS version, device/emulator model, endpoint family,
   result, timestamp, and a redacted screenshot or console-free observation.

## Evidence matrix

| Platform | Environment | Binary request | Binary response | Plain HTTP arbitrary port | Evidence |
| --- | --- | --- | --- | --- | --- |
| Node loopback on Windows | Node 26.1.0 | Pass | Pass | Pass | `pnpm test:transport`, 2026-07-28 |
| Windows Obsidian | Not installed in current environment | Not run | Not run | Not run | Required before v1.0.0 |
| Linux Obsidian | No Linux GUI/Obsidian environment available | Not run | Not run | Not run | Required before v1.0.0 |
| Android Obsidian | No SDK, emulator, attached device, or Obsidian APK available | Not run | Not run | Not run | Required before v1.0.0 |

No unsupported row is reported as passing. ADR 0002 remains a release gate until
the three Obsidian rows have reproducible evidence.
