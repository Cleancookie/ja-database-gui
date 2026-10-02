# 7. Credential storage — OS keyring, loud file fallback, or ask every time

Date: 2026-10-02
Status: Accepted. Supersedes [0003](0003-credential-storage.md).

## Context

0003 shipped passwords in plaintext and promised a keyring. The security audit
(`docs/SECURITY-AUDIT.md`, part A) found two things:

- 0003 is wrong about where they live. It says `connections.json`; the code
  writes `secrets.json`, a separate file.
- Windows is the shipped target, where the `0600` mode is not enforced at all.

## Decision

```
 config.Store ──▶ SecretStore
                    ├── KeyringSecrets   default. Service "ja-db", account = connection ID
                    ├── FileSecrets      only when the keyring probe fails. Plaintext. Loud.
                    └── (unavailable)    keyring used before, not answering now. Refuses.
 AskPassword connections: no SecretStore call at all.
```

1. **Library:** `github.com/zalando/go-keyring` v0.2.8, MIT. Pure Go. Windows
   Credential Manager, macOS Keychain, Linux Secret Service over D-Bus.
2. **Probe once at startup** (write, read back, delete). If it works the keyring
   is the backend. The first success drops `.keyring-in-use` in the config dir.
3. **File fallback only when the probe fails and the marker is absent.** It is
   plaintext, so it is never silent:
   - logged once at startup;
   - `SecretBackend()` on `internal/api`, over Wails and the dev server;
   - a warning that cannot be dismissed, above the whole UI and inside the
     connection form. It says that on a throwaway dev machine this may be fine.
4. **No split brain.** Once the keyring has worked in a config dir, a later
   outage does not fall back to a file. Backend `unavailable`: password reads
   and writes fail with a clear error, and the UI says so. Ask-every-time
   connections still work.
5. **Migration of `secrets.json`**, on `Open` when the keyring works. Per entry:
   `Set`, `Get`, compare, and only then remove the entry. The file goes when it
   is empty. It stops at the first failure and leaves the file intact, so the
   app stays usable: entries not yet moved are read from the file, and saving a
   password drops the stale file copy so a retry cannot overwrite it. Idempotent.
6. **Ask every time.** `Connection.AskPassword` is persisted; the password is
   not stored anywhere. The UI prompts, the password travels in the
   `Connect` request, is used to open the session and is not retained by
   ja-db's code. It is scrubbed from any error text. An open session is reused
   without asking again; each further database of the connection is a new
   session and asks again.
7. **Params** are stored in `connections.json` in plaintext and returned to the
   UI. They are not stripped. The form warns when a connection has any. The UI
   has no field for them; they are edited in the file.
8. **Directory hygiene:** `chmod 0700` on the config dir after `MkdirAll`, on
   non-Windows.

## Not done

- `connections.json` is not encrypted. Host, user and database name are low
  value next to a password.
- No master-password file. Crypto with no key source is theatre.
- Passwords are Go strings and cannot be zeroed. They sit in memory, and in the
  driver's connection pool for as long as a session is open. Accepted.

## The honest limit

Credential Manager is DPAPI. It protects the password from other users of the
machine and from someone who copies the disk. It does **not** protect it from
malware running as the same user, which can ask the same API for it. Ask every
time is the only mode where a stolen profile yields nothing.

## Consequences

- One new dependency, which brings `danieljoos/wincred` on Windows and a newer
  `godbus/dbus`.
- Tests mock the keyring (`keyring.MockInit`) and must never touch a real one.
- Not verified here: a real Windows Credential Manager run. Only the mock and
  the cross-compile.
