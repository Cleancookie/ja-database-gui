# ja-db

Just Another DB UI. A keyboard-first database GUI. Go core, React/webview UI, one binary.

Built as a replacement for TablePlus. Supports **MySQL/MariaDB, PostgreSQL, SQL Server and SQLite**.

## Why command-palette-first

There is no menu bar to hunt through. `Ctrl+P` opens the palette and everything is
reachable from it — connect, switch database, open a table, run a query, change page
size. The palette is context-aware: what it offers depends on what you have open.

## Status

MVP walking skeleton. Working end-to-end:

- Connection management (create / edit / delete / duplicate / test, persisted to disk)
- Browse databases on a server
- Browse tables, views, functions and procedures on a database
- Browse rows of a table or view
- `Ctrl+F` raw-SQL filter — whatever you type is appended after `WHERE`
- Pagination: page size, page number, or switched off entirely
- Long text/JSON columns capped by the *database*, marked in the grid, and openable
  in full — with a collapsible JSON viewer (`Enter` on a cell)
- SQL editor with a results grid (plain textarea for now, Monaco is a follow-up)

## Keybindings

| Key | Action |
| --- | --- |
| `Ctrl+P`  /  `Ctrl+Shift+P` | Go-to palette / command palette |
| `Ctrl+H` `Ctrl+J` `Ctrl+K` `Ctrl+L` | Move a cell in the grid — hjkl |
| `Ctrl+F` | Focus the WHERE filter |
| `Ctrl+E` | Toggle SQL editor |
| `Ctrl+Enter` | Run query (in SQL editor) |
| `Ctrl+R` | Refresh current result set |
| `Ctrl+←` / `Ctrl+↓` | Toggle the left / bottom pane |
| `Enter` | Open the selected cell (full value, JSON tree) |
| Right-click / `Menu` | Cell actions — open in viewer, copy value, copy full value |
| `Esc` | Close palette / dialog, or blur the filter |

## Running it

### Development (works anywhere, including WSL)

The Go core is transport-agnostic, so there is a dev HTTP server that exposes exactly
the same API the Wails bindings do. This is how you develop on Linux/WSL without a
native webview installed.

```sh
make dev   # terminal 1 — Go API on :34567
make web   # terminal 2 — Vite on :5173, proxying /api to the above
```

Open <http://localhost:5173>.

### Desktop app

```sh
make windows          # -> build/bin/ja-db.exe
make                  # list every target
```

For a native window with hot reload, run `wails dev` directly; on Linux it needs
`webkit2gtk-4.1` and `libgtk-3-dev`. Windows needs the WebView2 runtime (present on Windows 11 and any updated Windows 10).

## Tracking

- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — what was asked for, what was
  decided, and the invariants that must not regress
- [docs/WISHLIST.md](docs/WISHLIST.md) — wanted, not yet built

## Where things live

See [ARCHITECTURE.md](ARCHITECTURE.md). The short version:

```
internal/driver/    one file per dialect, behind a single Driver interface
internal/config/    connection store on disk
internal/engine/    live connections + query execution
internal/api/       the whole API surface, called by both transports
app.go              Wails binding — a thin pass-through to internal/api
cmd/devserver/      HTTP binding — the same, over JSON
frontend/           React + TS + Vite + Tailwind
```

## Committing

Subjects start with one of four emoji, which names the size of the change and
maps to a semver bump. Convention only — nothing enforces it, so it is on you
and on anything committing on your behalf.

| | | |
| --- | --- | --- |
| 🔥 | breaking change | major |
| ✨ | major change | major |
| 🛠️ | minor change — refactor, docs, tooling | minor |
| 🐛 | bug fix | patch |

```
✨ Add SQL autocomplete to the filter box and the editor
🐛 Stop Enter in the filter box opening the cell viewer
```

Rationale, and the reason ✨ is major rather than minor, in
[docs/adr/0004-commit-message-convention.md](docs/adr/0004-commit-message-convention.md).

## Credential storage

Passwords go in the OS keyring: Windows Credential Manager, macOS Keychain or the
Linux Secret Service. That protects them from other users of the machine. It does
not protect them from malware running as you.

**If no keyring is available** (often WSL or a bare Linux box) passwords fall back to
plain text in `secrets.json` under your user config directory. ja-db says so in a
banner that stays up. On a throwaway dev machine that may be fine; anywhere else,
tick "Ask for the password every time" on the connection and nothing is stored.

`connections.json` (hosts, users, database names) and a connection's extra `params`
are always plain text. Do not put secrets in `params`.

See `docs/adr/0007-credential-storage.md`.
