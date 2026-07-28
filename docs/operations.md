# Server operations

## Runtime boundary

Run one `ll-server` process per data directory and a dedicated unprivileged
service account. Expose only the configured TCP port. The HTTP surface contains
exactly `/v1/bootstrap`, `/v1/handshake`, and `/v1/envelope`; application
credentials and data travel only inside the pinned Noise channel.

Keep the server clock correct, monitor free disk space, and alert before the
64 MiB safety reserve can be reached. The service enforces object, request,
session, upload, device, commit, and rate limits, but operators should also use
host firewall and connection-rate controls.

## Example systemd unit

```ini
[Unit]
Description=Learning Loop encrypted object service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=learning-loop
Group=learning-loop
EnvironmentFile=/etc/learning-loop/server.env
ExecStart=/opt/learning-loop/ll-server /etc/learning-loop/config.toml
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/learning-loop

[Install]
WantedBy=multi-user.target
```

The environment file should be readable only by the service account and root:

```text
LEARNING_LOOP_SERVER_PASSWORD=use-a-password-manager-generated-value
```

## Backup

For a simple consistent backup:

1. Stop the service.
2. Copy the complete configured data directory to encrypted backup storage.
3. Verify the copy contains `server-identity.key`, `server-identity.pub`,
   `metadata.sqlite3`, and the object/upload directories.
4. Restart the service and verify its fingerprint is unchanged.
5. Periodically restore the backup into an isolated directory and start it on a
   loopback-only port with the same password.

Filesystem snapshots may be used while running only when they provide a
consistent point-in-time view of both SQLite and object files. A database-only
backup is incomplete.

## Upgrade

Verify the new archive and its internal payload checksums. Stop the service,
take a complete backup, replace only the executable and documentation, then
restart with the existing config and data directory. Unknown future database
schemas fail closed. Roll back the executable and complete backup together if
an upgrade fails.

## Logs and incident response

Logs intentionally omit passwords, proofs, keys, logical paths, plaintext,
encrypted payload contents, vault names, and full untrusted errors. Preserve
timestamps, stable error categories, process exit status, free-space data, and
the release checksum during an incident.

If identity-key disclosure is suspected, isolate the service, preserve a
forensic copy, notify every user, deploy a new isolated instance, and require a
deliberate fingerprint trust reset. Ciphertext should still be treated as
sensitive because password strength and future cryptanalysis affect its risk.
