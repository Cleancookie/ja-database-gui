# 3. Credential storage — file now, OS keyring next

Date: 2026-08-16
Status: Superseded by [0007](0007-credential-storage.md)

The audit found this ADR wrong: passwords were never in `connections.json`, they
were in a separate `secrets.json`. Kept as history.

## Context

Connections need a host, port, user, database and password. The password has to
survive a restart or the app is useless. Proper storage means the OS keyring
(Windows Credential Manager / macOS Keychain / libsecret), which is a platform-
specific dependency and, on Linux, one that is frequently absent or locked.

## Decision

For the MVP, connection metadata **and passwords** are stored in
`<user config dir>/ja-db/connections.json`, written with mode `0600` via a
write-to-temp-then-rename so a crash cannot truncate the file.

The store is written to be swappable: `config.Store` takes a `SecretStore` for the
password field alone. Today that is `FileSecrets`, which round-trips the password in
the same JSON. A `KeyringSecrets` can be dropped in without touching anything else —
the connection record already refers to its password by a stable `SecretRef` rather
than holding the value.

## Consequences

- Passwords sit in plaintext on disk. Any process running as the user can read them.
  This is the same posture as `~/.pgpass`, `~/.my.cnf` and a plain VS Code settings
  file, but it is materially worse than TablePlus, which uses the OS keychain.
- It is called out in the README rather than left for someone to discover.
- `0600` is a POSIX mode. On Windows it is not meaningful; the file inherits the
  user profile directory's ACL, which is user-only by default but not enforced by us.
  Keyring migration closes this properly.
- **This must not ship to anyone else's machine as-is.**
