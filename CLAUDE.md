# ja-db — agent instructions

Keyboard-first database GUI. Go core, React/webview UI, one binary.
Layout and rationale: [ARCHITECTURE.md](ARCHITECTURE.md). Decisions: `docs/adr/`.

## Commits

Always make small atomic commits and treat this as an append only log
This helps in future with telling a story of how the code came to be
Always aim to commit code at the end of every reply

Subject starts with one of exactly four emoji, then a space, then an imperative
capitalised description with no trailing full stop. Nothing enforces this — you
are the enforcement.

| | | |
| --- | --- | --- |
| 🔥 | breaking change | major |
| ✨ | new capability | minor |
| 🛠️ | minor change — refactor, docs, tooling, polish | minor |
| 🐛 | bug fix | patch |

```
✨ Add SQL autocomplete to the filter box and the editor
🐛 Stop Enter in the filter box opening the cell viewer
```

Only these four. Emoji names the *size* of the change, not the area — 📝/♻️/🔧
all land on 🛠️. No `AB#<ticket>` prefix in this repo; the subject is the whole
record. 🔥 is the only major — see
[docs/adr/0004](docs/adr/0004-commit-message-convention.md).

Before committing, check the subject you are about to write against that table.
When writing several commits in one turn, check each — this convention has
drifted before, always partway through a long session.

## Releasing

`make release` tags the next version and pushes it; CI builds and publishes it,
and running copies offer the update. The version is worked out from the commit
emoji since the last tag, so the convention above is what sets it. Release
after a finished feature or fix lands on main — ask first, since the push is
public. See [docs/adr/0010](docs/adr/0010-portable-exe-that-updates-itself.md).

## Working here

- `make check` (fmt + vet + typecheck + tests) before saying a change is done.
- Every query goes through the one middleware chain in `internal/api` — that is
  what puts it in the activity log. Do not call a driver directly to dodge it.
- `internal/api` is the whole API surface; `app.go` (Wails) and
  `cmd/devserver/` (HTTP) are thin pass-throughs. New capability goes in
  `internal/api` and is exposed by both, never in one transport only.
- One file per dialect in `internal/driver/`, behind the single `Driver`
  interface. A dialect quirk belongs in that dialect's file.
- Frontend follows the global style guide; the palette is the primary surface,
  so a new capability should be reachable from `Ctrl+P` / `Ctrl+Shift+P`.
- Requirements and invariants that must not regress: `docs/REQUIREMENTS.md`.
  Wanted but unbuilt: `docs/WISHLIST.md`.

## Reading and editing files

Read files with the Read tool, not `cat`/`head`/`tail`/`sed -n` through Bash.
Read is deduped and does not put both the command and its whole output into
context. Use Grep to search and Glob to list. Piping *command output* through
`head`/`tail` is fine and expected — `make check 2>&1 | tail -40`.

Change existing files with Edit, not Write. Write carries the entire file body
and that body then rides along in context for the rest of the session; on a
300-line component that is the difference between a hunk and the whole file.
Write is for new files.

## Context

Sessions here tend to run long and cover several unrelated features. When
moving to something that shares no state with what came before, say so and
suggest `/clear` — carried context is re-read on every subsequent turn and it
is the largest cost in a long session, well above model or effort choice.
