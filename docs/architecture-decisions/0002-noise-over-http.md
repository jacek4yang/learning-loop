# ADR 0002: Pinned Noise NK over minimal HTTP

- **Status:** Accepted with platform-validation release gate
- **Date:** 2026-07-28

## Context

The deployment cannot depend on a public TLS certificate, but an active network
attacker must not learn credentials or vault plaintext and must not impersonate
the server. Obsidian exposes `requestUrl()` on desktop and mobile and documents
HTTP/HTTPS requests without browser CORS restrictions.

## Decision

Serve three fixed HTTP/1.1 routes on one configured TCP listener. Use
`Noise_NK_25519_ChaChaPoly_BLAKE2s`, because the client pins the server static
key and both peers contribute fresh ephemeral keys. Bind protocol version,
instance ID, and exact suite into the Noise prologue. Authenticate the server
password and Ed25519 device identity inside the resulting channel.

Do not send a password, vault name, path, authorization token, or content in a
URL, query, ordinary header, log, or plaintext error. There is no
"ignore fingerprint mismatch" action.

## Consequences

- HTTP metadata, IPs, timing, and ciphertext sizes remain visible.
- The server identity key is a critical persistent asset.
- Request-response sessions need an opaque body-level handle because
  `requestUrl()` does not guarantee connection affinity.
- The project must test cleartext HTTP binary exchange in installed Obsidian on
  Windows, Linux, and Android before v1.0.0.

## Validation status

The current Windows environment has no Obsidian installation, Android SDK,
emulator, or attached device. Official API documentation confirms that
`requestUrl()` accepts HTTP/HTTPS and returns binary responses, but that is not
substituted for an executed platform test. A loopback spike and exact manual
matrix are committed in Phase 0; all three platform rows must have captured
evidence before this release gate can be closed.

If Android blocks cleartext HTTP in the installed Obsidian runtime, development
must stop at this decision boundary and replace this ADR with a verified
transport. A self-signed certificate without a verified trust path is not an
acceptable silent fallback.
