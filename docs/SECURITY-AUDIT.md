# Security audit — 2026-10-01

Handover for the agent that fixes these. Read-only audit; nothing was changed.
Branch audited: `keyset` @ `9bd44d4`.

**Verified by hand:** everything in Part A (code read directly).
**Reported by sub-audits, not re-checked:** the `file:line` refs in Part B.
Re-read each location before editing it.

## Verdict

- No High findings.
- SQL construction is sound. No injection crosses a trust boundary.
- Weak spots: **credential storage**, TLS defaults, an unauthenticated dev server.

The owner's priority is **A: credential storage**. Do it first.

---

## A. Credential storage (priority)

### A1. What exists today

```
 UI ──SaveConnection(conn, password)──▶ api.Service
                                           │
                                           ▼
                                    config.Store (store.go)
                                     │               │
                       metadata, no password        password only
                                     ▼               ▼
                          connections.json     secrets.json   ◀── PLAINTEXT
                          (mode 0600)          (mode 0600)        { "<connID>": "hunter2" }
                                     └──── dir ~/.config/ja-db  (0700) ────┘
                                           %AppData%\ja-db on Windows
```

| Fact | Where |
| --- | --- |
| Password lives only in `secrets.json`, keyed by 8-byte hex connection ID | `internal/config/secrets.go:22-28`, `store.go:71`, `newID` `store.go:275` |
| `Connection` struct has no password field, so `ListConnections` never returns it | `store.go:26-41` |
| `SecretStore` interface (`Get/Set/Delete`) is the swap seam | `secrets.go:16-20` |
| Password is read only at connect time via `Store.DriverConfig` | `store.go:233-253` |
| Files written atomically (temp + rename), chmod 0600 | `store.go:286-311` |
| Dir created 0700 with `MkdirAll`, which does **not** tighten an existing dir | `store.go:68` |
| `0600` / `0700` mean nothing on Windows; the real protection is the profile ACL | ADR 0003 |

### A2. Problems

```
 P1  Plaintext on disk. Any process as the same user can read every password.
 P2  Windows is the shipped target (build/windows). 0600 is a no-op there.
 P3  connections.json is also sensitive and unprotected: host, user, db name
     reveal the topology of production systems.
 P4  Connection.Params (map[string]string) is persisted in connections.json
     AND returned to the UI. A secret typed into Params (ssl key password,
     token, ...) bypasses SecretStore entirely.
 P5  MkdirAll leaves an existing, looser dir mode untouched.
 P6  Orphans: Create persists the connection first, then the password. If Set
     fails you get a connection with no password (reported, but not rolled
     back). Delete reports a leftover secret but the connection is already gone.
 P7  ADR 0003 is wrong. It says connections.json holds passwords; the code uses
     a separate secrets.json.
 P8  Passwords are Go strings: cannot be zeroed. Accept; note it.
```

Not a problem (checked): the password is not logged, not in connect errors, not
returned by any API method. Postgres and MSSQL DSNs use `url.UserPassword`.

### A3. Target design

```
 config.Store ──▶ SecretStore (interface, unchanged)
                     ├── KeyringSecrets   ◀── NEW, default where a keyring exists
                     │     Windows Credential Manager / macOS Keychain /
                     │     Linux Secret Service (libsecret)
                     └── FileSecrets      ◀── fallback ONLY, never silent
```

Rules:

1. **Keyring is the default.** Service name `ja-db`, account = connection ID.
2. **File fallback MUST be loud.** On Linux/WSL a keyring is often absent or
   locked. Fall back to `FileSecrets` only when the keyring probe fails, and:
   - log it once at startup,
   - expose a `SecretBackend()` value through `internal/api` so the UI can show
     "passwords stored in plaintext file" in the connection form and status area,
   - never fall back after a *write* to the keyring succeeded (no split brain).
3. **Migrate once, safely.** On `Open`, if `secrets.json` exists and the keyring
   works: for each entry `Set`, then `Get` and compare, and only then remove that
   key. Delete the file when empty. Never delete before the read-back matches.
   Failure leaves the file intact and the app usable.
4. **Params.** Decide and document: either reject/strip known-secret keys, or
   warn in the form that `Params` is stored in plaintext. Do not silently accept.
5. **Dir hygiene.** After `MkdirAll`, `Chmod(dir, 0o700)` on non-Windows.
6. **Tests.** An in-memory fake `SecretStore` for `Store` tests; table tests for
   migration (success, partial failure, keyring unavailable, read-back mismatch).
   The migration MUST be idempotent.
7. **Nothing outside `internal/config` may hold a password longer than one call.**
   Keep that invariant (see `docs/REQUIREMENTS.md:591`).

### A4. Open decisions (ask the owner, do not guess)

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Library: `github.com/zalando/go-keyring` (pure Go, three OSes, Secret Service over D-Bus) vs hand-rolling | Evaluate go-keyring. Check licence, maintenance, current version before adding. One new dependency is acceptable here. |
| 2 | Devserver on WSL has no keyring | Fall back to file, loud. Devserver is dev-only. |
| 3 | Encrypt `connections.json` too? | No. Hosts/users are low value next to passwords. YAGNI. Revisit if P3 matters to the owner. |
| 4 | Optional master passphrase for the file fallback | No for now. Real crypto without a key source is theatre. |

### A5. Docs to update in the same series

- New ADR `docs/adr/0007-…` superseding 0003. Mark 0003 as superseded.
- `docs/REQUIREMENTS.md:623` (the plaintext gap) and `:591`.
- `README.md` warning about plaintext passwords.

### A6. Acceptance

- `make check` green.
- On a machine with a keyring: after migration `secrets.json` is gone and
  connecting still works.
- With the keyring unavailable: app still works, UI shows the plaintext warning.
- Grep of `ja-db.log`, API responses and the activity log contains no password.
- The capability is reachable from `Ctrl+P` / `Ctrl+Shift+P` where a UI action is added.

---

## B. Other findings

```
Sev   #   Where                                  Fix
───── ─── ────────────────────────────────────── ───────────────────────────────────────────
MED   B1  driver/postgres.go:61-64               default sslmode=prefer is downgradable, no
                                                 cert check. Default verify-full (or require
                                                 for loopback). Allow-list SSLMode per dialect.
MED   B2  driver/mssql.go:60-68                  TrustServerCertificate=true always. Verify by
                                                 default; explicit opt-in checkbox + warning.
MED   B3  driver/mysql.go:61-62                  plaintext unless SSLMode set. Default
                                                 tls=preferred, true for non-loopback.
MED*  B4  cmd/devserver/main.go:~200-235         no Host/Origin check: DNS rebinding can run
                                                 SQL on saved connections. Reject Host not in
                                                 {127.0.0.1,localhost,[::1]}:port; require
                                                 Origin absent or allowed; optional per-run
                                                 token header. Same hole via Vite proxy :5173.
MED   B5  frontend/src/selection.ts:83-90        csvField writes cells starting = + - @ \t \r
                                                 raw: Excel formula injection. Prefix ' on the
                                                 file-export path (store.ts:1340-1360);
                                                 clipboard may stay byte-faithful.
LOW   B6  driver/mysql.go:61-71                  DSN built by Sprintf; `?k=v` in a db name
                                                 injects params. Use mysql.Config.FormatDSN().
LOW   B7  driver/sqlite.go:54                    "file:"+path+"?" not URI-escaped. Escape;
                                                 consider mode=rw for existing files,
                                                 trusted_schema=0 for untrusted .db files.
LOW   B8  api/service.go:63-70, app.go:58,       errors and client log lines logged with %v:
          devserver main.go:162                  newline forging, row values (PG "Key (email)
                                                 =(…)") persisted. Use %q, cap length.
LOW   B9  driver/scan.go:140-200                 no total byte cap or per-query timeout; text
                                                 cap applies after the value is read. Add a
                                                 running byte budget (~256 MB) and optional
                                                 statement timeout setting.
LOW   B10 devserver main.go:220                  io.ReadAll without MaxBytesReader; no
                                                 ReadHeaderTimeout. Cap ~16-64 MB.
LOW   B11 main.go, frontend/index.html           no CSP. Add default-src 'self'; style-src
                                                 'self' 'unsafe-inline'; img-src 'self' data:
INFO  B12 docker-compose.yml, Makefile           pin mssql:2022-latest by digest; use npm ci
                                                 for release builds; run govulncheck in CI.
```

\* Dev-only. `wails build` never builds the devserver. Matters while `make dev`
runs in a browser-reachable session with real connections loaded.

### B4 picture

```
 evil.com ──rebind DNS──▶ 127.0.0.1:34567   (no Host check, no auth)
                               ├─ /api/Connect     uses the stored password
                               ├─ /api/RunSQL
                               └─ /api/DropObject
```

## C. Checked and clean — do not "fix"

- Identifier quoting: every identifier goes through `QuoteIdent` (`driver.go:391-467`).
- Inserts, updates, deletes are parameterised (`write.go`). `mssql` `sp_executesql` quoting is right.
- No XSS sinks in the frontend. Cells render as React text. No `localStorage`/`sessionStorage`.
- No secrets in git history. Docker credentials are dev-only and bound to loopback.
- `npm audit --omit=dev`: 0 vulnerabilities. Go modules look current.
- The raw filter fragment (ADR 0002) is intentional. **Invariant:** it must only ever
  come from a keystroke, never a saved/shared tab or URL.

## D. Suggested order

```
 1  A  keyring + migration + loud fallback   ← owner's priority
 2  B1-B3  TLS defaults + SSLMode allow-list (frontend form change too)
 3  B4 + B10  devserver Host/Origin check + body cap
 4  B5  CSV formula escaping
 5  B6-B8, B11  DSN, logging, CSP
 6  B9, B12  resource budget, build hygiene
```

## E. House rules for whoever fixes this

- Small atomic commits, append-only. Subject: one of 🔥 ✨ 🛠️ 🐛, space, capitalised
  imperative, no trailing full stop. Check each subject against the table in `CLAUDE.md`.
- `make check` before saying anything is done.
- New capability goes in `internal/api` and is exposed by **both** `app.go` and
  `cmd/devserver/`. One file per dialect in `internal/driver/`.
- Every query stays on the one middleware chain in `internal/api`.
- Edit with Edit, not Write. Read with Read.
- Changing TLS defaults changes behaviour for existing saved connections. Say so
  in the commit body and in `docs/REQUIREMENTS.md`.
