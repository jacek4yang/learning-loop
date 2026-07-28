# Security Policy

## Development status

Learning Loop has not reached a stable release. Do not entrust irreplaceable or
sensitive data to development builds.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Send a private report
to the security contact published with the repository or use the hosting
provider's private vulnerability-reporting feature. Include affected versions,
reproduction steps, impact, and any proposed mitigation. Do not include real
vault data, passwords, private keys, tokens, or server addresses.

## Security boundary

The server stores opaque encrypted objects and intentionally cannot decrypt note
content, logical paths, Properties, Canvas data, or attachments. The client
encryption password never leaves the client and is not persisted by the plugin.
The separate server access password only authorizes use of the service and
cannot decrypt vault data.

Once unlocked, the Obsidian process necessarily reads local Markdown plaintext.
A normal Obsidian plugin cannot keep local files encrypted at all times while
also preserving native editing, search, and link behavior. Locking the plugin
clears in-memory key material and stops synchronization; it does not re-encrypt
the local Markdown files.

Protect local devices with BitLocker, FileVault, LUKS, or Android device
encryption and a strong screen lock. Back up the server identity, vault key
envelope, and recovery material according to the release documentation. Loss of
the client encryption password cannot be recovered by the server.

No system is absolutely secure. Security claims must be tied to the documented
threat model and verified implementation.
