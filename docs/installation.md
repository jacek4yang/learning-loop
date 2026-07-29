# Installation and recovery

## Verify release files

Download the required server package, the plugin package, and the top-level
`SHA256SUMS` from the same release. Verify before extracting.

Linux or macOS:

```bash
sha256sum -c SHA256SUMS
```

Windows PowerShell:

```powershell
Get-FileHash .\learning-loop-server-1.0.1-windows-x86_64.zip -Algorithm SHA256
Get-FileHash .\learning-loop-plugin-1.0.1.zip -Algorithm SHA256
```

Compare the displayed lowercase hashes with `SHA256SUMS`. Each archive also
contains a second `SHA256SUMS` covering its extracted payload.

## Install and start the server

Choose exactly one native package:

| Operating system | Package suffix |
| --- | --- |
| Linux x86-64 | `linux-x86_64` |
| Linux ARM64 | `linux-aarch64` |
| Windows x86-64 | `windows-x86_64` |
| Windows ARM64 | `windows-aarch64` |
| macOS Intel | `macos-x86_64` |
| macOS Apple silicon | `macos-aarch64` |

Extract the archive into a dedicated application directory. Copy
`config.example.toml` to a location outside the application directory as
`config.toml`. Replace the data directory and listen address as needed, but
keep exactly the three supported fields.

Set a unique server access password of at least 16 characters in the named
environment variable. Do not put the password directly in a checked-in file.

Linux or macOS:

```bash
export LEARNING_LOOP_SERVER_PASSWORD='use-a-password-manager-generated-value'
./ll-server /absolute/path/to/config.toml
```

Windows PowerShell:

```powershell
$env:LEARNING_LOOP_SERVER_PASSWORD = 'use-a-password-manager-generated-value'
.\ll-server.exe C:\absolute\path\to\config.toml
```

On first start, record the printed `SHA256:...` fingerprint through a trusted
channel. The server data directory contains the persistent identity, database,
and opaque objects. Restrict its permissions to the service account.

## Install the Obsidian plugin manually

1. Extract `learning-loop-plugin-1.0.1.zip`.
2. Create `<Vault>/.obsidian/plugins/learning-loop/`.
3. Copy `manifest.json`, `main.js`, `styles.css`, `core.wasm`, and
   `versions.json` into that directory.
4. In Obsidian, enable Community plugins and then enable **Learning Loop**.
5. The first-run setup opens automatically. You can reopen it from the
   Learning Loop right sidebar at any time.
6. Enter the server host, port, trusted fingerprint, server access password,
   a different strong client encryption password, and a device name.

The server password is stored through Obsidian SecretStorage. The client
encryption password remains memory-only and is required after a process restart.
After configuration, Learning Loop opens the client-password unlock dialog when
Obsidian starts, then synchronizes after a successful unlock.
The local Vault stays ordinary readable Markdown while unlocked or disabled;
protect the device with full-disk encryption and a strong screen lock.

## Restore on a new device

Install the same plugin version into an empty Vault, run setup, and enter the
same server address, pinned fingerprint, server password, and client encryption
password. Choose a new device name. The client authenticates to the server,
retrieves the password-wrapped vault key, creates a fresh device signing key,
and downloads the verified encrypted commit graph.

Do not copy `data.json` between devices. Each device needs a distinct signing
identity. If the first pull reports a path collision, resolve the named paths
on an existing device and synchronize again; Learning Loop never silently
renames colliding data.

## Password and key backup

Store these in a password manager or offline recovery record:

- the server access password;
- the separate client encryption password;
- the server host, port, and pinned fingerprint;
- the complete server data-directory backup and its access instructions.

The server cannot recover a forgotten client encryption password. Losing both
that password and all unlocked/local plaintext copies makes the encrypted
server data unrecoverable.

## Disaster recovery

- **Lost client device:** revoke it from another authorized device, then create
  a new device identity during setup.
- **Lost server host:** restore the entire stopped-server data directory,
  including `server-identity.key`, database, and objects, then use the same
  password and configuration.
- **Changed server fingerprint:** clients must stop. Restore the original
  identity or perform a deliberate trust reset after independently verifying
  why the identity changed. Never accept a surprise fingerprint.
- **Corrupt head index:** restart initialization recomputes heads from immutable
  parent edges. Preserve a backup before attempting any manual repair.
- **Deleted generated Canvas:** run the corresponding rebuild command; manual
  Thinking canvases are never overwritten.

See [operations.md](operations.md) for backup and service procedures and
[release-validation.md](release-validation.md) for the exact validation scope.
