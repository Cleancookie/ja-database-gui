# Architecture

## Layers

```
                 ┌──────────────────────────────────┐
   Wails binding │  app.go        (desktop)         │
   HTTP binding  │  cmd/devserver (browser / dev)   │
                 └───────────────┬──────────────────┘
                                 │  both call the same methods
                 ┌───────────────▼──────────────────┐
                 │  internal/api.Service            │  request/response DTOs
                 └───────┬──────────────────┬───────┘
                         │                  │
          ┌──────────────▼─────┐   ┌────────▼─────────────┐
          │ internal/config    │   │ internal/engine      │
          │ saved connections  │   │ live *sql.DB pool    │
          └────────────────────┘   └────────┬─────────────┘
                                            │
                                   ┌────────▼─────────────┐
                                   │ internal/driver      │
                                   │ Driver interface     │
                                   │ mysql/pg/mssql/sqlite│
                                   └──────────────────────┘
```

### Why two transports

`internal/api.Service` contains all behaviour and knows nothing about Wails. `app.go`
and `cmd/devserver` are both ~100 lines of pass-through. That buys three things:

1. Development on Linux/WSL, where no native webview is installed.
2. The frontend can be exercised in a normal browser with normal devtools.
3. If Wails is ever the wrong choice, only the binding layer is thrown away.

The frontend picks its transport at runtime (`frontend/src/api.ts`): if
`window.go` exists it uses Wails bindings, otherwise it POSTs to `/api/:method`. The
call signatures are identical, so no component knows or cares which is in play.

## The frontend component layer

`frontend/src/ui/` is the only place allowed to import a component library.
Everything else imports from `../ui` and sees our own narrow API — `Dialog`
takes `title`, `footer` and children, not a dozen vendor subcomponents.

Radix Primitives sits behind it, chosen for behaviour rather than styling:
focus trapping and restoration, scroll locking, `aria-hidden` on the
background, and keyboard navigation with typeahead in menus. All of that was
either missing or faked in the hand-rolled versions, and all of it matters in
an app driven from the keyboard. The styling stays ours — Radix ships none.

Deliberately *not* behind the layer: the command palette (its ranking in
`fuzzy.ts` is the point of it), the data grid (virtualised), and native
`<select>`/`<checkbox>` (already correct and accessible).

The second thing behind the layer is `ui/Editor.tsx`, wrapping CodeMirror 6 for
the SQL editor and the filter box. It is the app's largest dependency by some
margin (120 kB gzipped) and is loaded on demand through `ui/LazyEditor.tsx`,
because at launch neither surface that uses it is mounted. The reasoning —
including why not Monaco — is in `frontend/src/ui/README.md`.

The split worth preserving: *what* can be completed lives in
`src/completion.ts` as plain data with no editor API in it, so the candidate
rules are unit-tested without a DOM; only *how* it is offered is CodeMirror's
business.

One mismatch the layer absorbs: this app mounts a dialog already-open and
unmounts it to close, so Radix's own open→closed transition never runs and its
focus restore never fires. `ui/Dialog.tsx` captures the opener during first
render and restores focus on unmount. That is the kind of vendor-shaped detail
the boundary exists to keep out of the rest of the app.

## Every query goes through one door

`internal/query.Runner` is the only way `internal/api` runs anything against a
database:

```go
err := s.runner.Do(ctx, query.Op{...}, func(qctx context.Context) error { ... })
```

Cross-cutting behaviour is middleware wrapped around that call, so it applies
to everything by construction rather than by each call site remembering:

| Middleware | Does |
| --- | --- |
| `Tracking` | Registers with `internal/activity` — the tray row, the cancellable context, the terminal phase in the history |
| `Logging` | One line per finished query: id, kind, database, rows, duration, error |

Order matters and is fixed in `api.New`: `Tracking` is outermost, so it supplies
the context everything else runs under and assigns the id that log lines share
with the tray.

This replaced eight hand-assembled call sites, each of which registered,
set a phase and released by hand. That duplication was not theoretical: one site
returned its result directly instead of assigning it, so the deferred release
saw a nil error and **every failed editor statement was recorded as successful**
until a merge exposed it. `TestBrowsingRecordsEveryQueryItRuns` is the guard
against a new method quietly bypassing the runner.

Adding a slow-query warning, a retry, or per-connection rate limiting is a new
`Middleware` and nothing else.

One honest limitation: for introspection, `Op.SQL` is a label ("describe
auth.users") rather than a statement, because the drivers assemble their own
catalogue queries internally and each dialect asks a different question. It is
the one place the log is not literally what was sent.

## The activity log keeps everything

Catalogue reads are retained like any other query. They were dropped
originally — they fire on every table open and tree expansion, and would push
the user's own queries out of the ring — but the effect was a log that could not
be trusted: a describe was visible for the milliseconds it ran and then vanished,
so it read as never having been recorded.

So the ring holds every kind (500 entries), and the tray filters catalogue reads
out of the *view* by default, with a toggle in its header. A read that is still
running is always shown whatever its kind, because a slow `information_schema`
query is exactly the thing worth seeing. Hiding is a display choice the user can
reverse; dropping was not.


## Two palettes, and no top bar

There is no menu bar, toolbar or header. The window is a tab sidebar,
content, and the activity tray along the bottom — each a rounded island on a
gutter (`.island` in `index.css`). Everything that was in the old top bar — the
palette button, the settings cog, the busy indicator, the active table name —
moved to where it belongs or to a palette entry, because a permanent strip of
three buttons is ornament in an app driven from the keyboard.

Where those went, since "it was removed" is the wrong answer for some of them:

| Was in the header | Now |
| --- | --- |
| Settings cog | `Ctrl+,`, or "Settings" in the action palette |
| Palette button | The palettes themselves, advertised on the empty state |
| Active table name | The filter row, next to the `WHERE` it applies to |
| "working…" | The tray's indeterminate bar, which is the same fact with more detail |
| "dev (browser)" | The tray strip, and only in the browser transport |

The palette is split in two, on the editor convention:

- **`Ctrl+P` — go**: tables, views, databases, connections. Places.
- **`Ctrl+Shift+P` — do**: settings, the SQL editor, the tray, pagination,
  managing connections. Actions.

One list had seventeen tables competing with twenty commands for the same two
keystrokes, and the relative cutoff in `fuzzy.ts` could not help — the lists are
not comparable, so a strong table match was suppressing weak-but-wanted
commands and vice versa. Splitting them is what makes two characters enough.

`Ctrl+K` used to open the "go" palette as well, as the only palette key before
the split. It was given up — along with `Ctrl+J`, which was the tray — so that
the grid could take `Ctrl+H`/`J`/`K`/`L` for movement: hjkl is only worth having
if all four letters sit on the same modifier, and a keyboard-first grid is where
a hand should not have to leave the home row. The tray moved to ``Ctrl+` ``, and
the palette moves on `Ctrl+J`/`K` too, so one movement pair works everywhere.

`Ctrl+Shift+P` also switches between the two while one is open; `Ctrl+P` cannot,
because inside a palette it is already the emacs-style move-up binding.

## Tabs, and a palette that remembers

The left rail is the tab sidebar (ADR 0006, amended by ADR 0009). A tab is a
workspace on one connection and one database: the tables opened in it, each
with its filter, sort and page, plus that tab's own SQL editor and details
page. The active tab is expanded in the sidebar once it has a database: a
table search, the SQL editor, the open tables and every table and view. Other
tabs are one line each. With no database chosen, the main panel shows a
stepped server, then database picker (`WorkspacePicker`); the sidebar holds
tabs and tables only. A bound tab with no table open shows `EmptyPanel`.

The store keeps one flat set of "active" fields and nearly every component
reads them directly. A tab is a saved copy of that set (`frontend/src/tabs.ts`):
switching stashes the live fields into the tab being left and writes the other
tab's back. Staged edits, the recent list, settings, dialogs and the activity
tray are global. A response meant for a tab the user has left is dropped (row
fetches by the existing sequence counter, connect / database / details by a
check of the active tab), and a tab left mid-load reloads when returned to.

Open tables work the same way one level down. `openTables` holds each table's
filter, sort and page; `activeRef` is the one on screen, and its entry is stale
while it is. `openObjectAt` in `store.ts` is the single choke point: it writes
the live controls into the table being left, then restores the target's and
fetches its rows. Rows are never kept for a table that is not on screen.

`Ctrl+P` opens a table in the *current* tab; open tabs appear in the same
palette as a `Tabs` group to jump to. Choosing another database goes through
`openWorkspace`, which opens a new tab unless the current one has no database
yet.

The main panel is routed. What it shows is a *page* (`pageOf` in `tabs.ts`):
empty, table, SQL editor, details or activity. A subscription at the bottom of
`store.ts` records every change of page, switching tab included, into one list
(`nav`, `navAt`). The mouse back / forward buttons walk it across tabs, with
the filter, sort and page a table had when it was left (Shift: between tabs).
Going back is wrapped in `navigating` so it does not record itself, and pages of
closed tabs are skipped. Going back to a table that was closed opens it again.

Objects are still offered most-recently-opened first, in a `Recent` group above
the rest of the catalogue. Alphabetical order is no help when switching between
two tables, since the two being compared are rarely neighbours in the alphabet.

Recency is a **bias**, not a sort key (`frontend/src/recency.ts`), which is what
lets it coexist with matching. On an empty query a candidate's score *is* its
bias, so the list opens in recency order; on a typed query a clearly better name
match still wins. The magnitude — 0.3 — was chosen against the other biases: it
exceeds the -0.25 noisy-schema penalty, so a table opened moments ago in
`extensions` still surfaces, because having just looked at something is better
evidence than the schema's reputation.

The object currently on screen is excluded, since offering to navigate to where
you already are is noise at the top of the list. The list is session-only; keys
are `database\0schema\0name`, NUL-separated because an identifier may contain a
dot and `('a', 'b.c')` must not collide with `('a.b', 'c')`.

## Command palette matching

Scoring is delegated to `fuzzysort` (`frontend/src/fuzzy.ts`) — the same class
of matcher behind VS Code's file finder. What stays local to this app:

- **Where to match.** A bare query is scored against the object *name*; the
  schema and hidden keywords are only consulted at a discount, so "user" finds
  `auth.user` rather than everything in a schema whose name contains those
  letters.
- **Bias.** Framework schemas (Supabase's `extensions`, `graphql`, …) and
  routines are demoted so a real table wins a close contest.
- **A relative cutoff.** This is what makes the list feel filtered. Fuzzy
  matching is inherently permissive — "user" legitimately matches `customers`
  via c-U-S-t-om-E-R-s — so results below half the best score are dropped. With
  a strong hit on screen the junk disappears; with only weak hits, they are all
  still offered rather than showing nothing.

Two rendering details that are easy to get wrong and were both bugs:

- Ranking interleaves groups, but the list draws a heading whenever the group
  changes — which produced a dozen headings for seventeen results. Results are
  regrouped after ranking, each group ordered by its best member.
- Match positions index the candidate *name*, while the row renders the longer
  *title* ("auth.user", "Connect to prod"). They must be shifted onto the title
  or the highlight lands on the wrong characters.

## The driver interface

Every dialect implements `driver.Driver` (see `internal/driver/driver.go`). The
interface is deliberately introspection-shaped rather than SQL-shaped — it returns
`[]Database`, `[]SchemaObject`, `[]Column`, not raw rows — because the four dialects
disagree profoundly about how you ask those questions.

The main asymmetries the interface has to absorb:

| | MySQL/MariaDB | PostgreSQL | SQL Server | SQLite |
| --- | --- | --- | --- | --- |
| Server hosts many DBs | yes | yes, but one per connection | yes | no, one file |
| Schemas within a DB | no (db *is* the schema) | yes | yes | no |
| Switching database | `USE db` on same conn | new connection required | `USE db` on same conn | n/a |
| Identifier quoting | `` `x` `` | `"x"` | `[x]` | `"x"` |
| Placeholder | `?` | `$1` | `@p1` | `?` |
| Pagination | `LIMIT n OFFSET m` | `LIMIT n OFFSET m` | `OFFSET m ROWS FETCH NEXT n ROWS ONLY` | `LIMIT n OFFSET m` |

`engine` keys its pool on `(connectionID, database)` for **every** dialect.
Postgres has no choice, since it cannot switch database on an open connection.
The others could switch with `USE`, and used to be pooled per connection alone
on the grounds that they reach other databases through qualified names — which
is true for browsing, where the driver qualifies every name it emits, and false
for the SQL editor, where `select * from users` means whatever the connection's
default database is.

`USE` cannot fix that: a `Session` holds a `*sql.DB`, which is a pool, so `USE`
would run on whichever pooled connection served it and leave the rest pointing
at the old database — the editor's target would depend on which socket it got.
Putting the database in the DSN, which is what keying per database does, is the
only version that holds for a pool.

SQL Server's `OFFSET/FETCH` requires an `ORDER BY`. When the user has not chosen a
sort, the mssql driver falls back to ordering by the primary key, then by the first
column, so pagination stays stable.

### Schema changes

`BuildTruncate`, `BuildDrop` and `BuildCreateTable` are the three statements the
object menu can run, and they are on `Driver` for the same reason everything else
is: the wording differs per dialect, and the differences are not cosmetic.

| | MySQL/MariaDB | PostgreSQL | SQL Server | SQLite |
| --- | --- | --- | --- | --- |
| Empty a table | `TRUNCATE TABLE` | `TRUNCATE TABLE` | `TRUNCATE TABLE` | no `TRUNCATE` — `DELETE FROM` |
| `CREATE` across databases | qualified name works | n/a, one DB per connection | must be the *current* database | n/a |
| Identity column | `bigint AUTO_INCREMENT` | `bigserial` | `bigint IDENTITY(1,1)` | `INTEGER PRIMARY KEY` |

Two of those need explaining.

SQLite's `DELETE FROM` is not a `TRUNCATE` in disguise — it fires triggers and it
rolls back. `Capabilities.TruncateIsDelete` exists so the confirmation dialog can
say which statement it is about to run, and `ddl_test.go` asserts the flag and the
statement agree.

SQL Server accepts a database qualifier on `CREATE TABLE` only when it names the
current database, but this driver reaches other databases by qualifying rather
than by switching — so a three-part `CREATE` fails on exactly the case the
sidebar makes easy. The statement is sent through the target database's own
`sp_executesql` instead. A `USE` prefix would also work, and would leave the
pooled connection pointing at a different database for whoever picked it up next
— the same trap described above.

The portable half lives in `internal/driver/ddl.go`: a column list and a
table-level `PRIMARY KEY`, so a composite key needs no special case. Column types
and defaults are raw fragments, like the filter (`docs/adr/0002`), guarded only
against a semicolon or a comment so a typo cannot append a second statement.

Nothing here emits `CASCADE`. Postgres refusing to truncate a referenced table is
the useful answer; a menu item that quietly empties tables the user did not name
is not.

The frontend never assembles DDL. `PreviewCreateTable` asks the driver to render
the statement without running it, so the SQL shown in the dialog is produced by
the same code that will execute it.

## Row edits

Edits are a staged change set, previewed and then applied in one transaction:
`Service.PreviewChanges` and `ApplyChanges`, both built by `planChanges` →
`Driver.BuildChange` (`internal/driver/write.go`), so the SQL shown is the SQL
run. `ReadRows` reports `EditKey` and per-column `Editable` from
`Driver.EditFacts`, cached beside the column list. Each change is addressed by
that key alone and must affect exactly one row. Values are bound, never spliced
in. Reasoning: `docs/adr/0005-row-editing.md`.

The grid's half mirrors it. `frontend/src/edits.ts` is the pure staging model,
`storeEdits.ts` puts it in the store beside the open cell editor and the review (staged
edits are per table, all within one connection and database),
and `ReviewChangesDialog` is the one place `applyChanges` is called from — see
the invariants in `docs/REQUIREMENTS.md`.

## Row browsing and the filter box

`Ctrl+F` is a raw SQL fragment appended after `WHERE`. It is **not** escaped or
parsed — that is the point, it is an expert tool, the same as TablePlus. The query is
assembled as:

```sql
SELECT * FROM <quoted ref> [WHERE <user fragment>] [ORDER BY <sort>] [LIMIT/OFFSET]
```

The user fragment is interpolated, so a malformed fragment produces a database syntax
error that is shown verbatim in the UI. This is intentional and is documented in
`docs/adr/0002-raw-sql-filter.md`. It is safe because the fragment is authored by the
person who already holds the credentials — but it means the filter box must never be
fed anything that did not come from a keystroke.

Everything *around* the fragment — table names, schema names, sort columns, limits and
offsets — is quoted or parameterised by the driver. Only the fragment is raw.

## Pagination

Three modes, chosen in the UI and carried on every `ReadRows` request:

- **Paged** (default): `limit = pageSize`, `offset = (page-1) * pageSize`.
- **Off**: no `LIMIT` clause is emitted. A `HardRowCap` of 100k rows still applies in
  `engine` so a mistake cannot exhaust memory; the UI reports when the cap trims a
  result.
- **Count**: exact row counts are a separate, optional call (`CountRows`), because
  `SELECT count(*)` on a large table is slow and should not be on the hot path of
  every page turn. The UI fetches a page first, then the count in the background.

## Query activity

`internal/activity.Registry` wraps every query the app issues, so what is
in-flight is a fact the backend already holds and cancellation is just closing
that query's context. Two surfaces read it, split by the shape of the data:

- **The tray** (`components/ActivityTray.tsx`) — queries: what is in flight,
  above a bounded history of what has finished. One line each, wanted while
  looking at something else, so it lives along the bottom of every view with a
  collapsed strip that is always visible.
- **The page** (`components/ActivityPage.tsx`) — `activity.sessions`, the pool
  stats per open connection. Stable and tabular; a page, reached by
  `Ctrl+Shift+A`.

### Lifecycle states

The status column is the app's own instrumentation, not the server's opinion:

| Phase | Set where |
| --- | --- |
| `queued` | `activity.Begin` — registered, not yet handed to `database/sql` |
| `executing` | `driver.RunQuery`/`Exec` before `QueryContext`, and in `api` before each introspection call. Covers the wait for a pooled connection *and* the server's work |
| `reading rows` | after `QueryContext` returns; `RowsRead` advances every 512 rows |
| `cancelling` | `Registry.Cancel`, until the driver unwinds |
| `done` / `failed` / `cancelled` | the function `Begin` returned, from the error it is passed |

Driver-level code reports through the context (`activity.SetPhase`,
`activity.AddRows`), so `internal/driver` never touches the registry and a
context without a tracker is a silent no-op. There is deliberately no separate
"scanning" phase: reading and normalising are the same loop, so it would flicker
per row and say nothing — the row counter is the honest version of it.

Real server-side state (`SHOW PROCESSLIST`, `pg_stat_activity`,
`dm_exec_requests`) is a wishlist item, not this. It needs every query pinned to
its own `*sql.Conn`; see `docs/WISHLIST.md`.

### History

Finished queries stay in the pane, so the tray doubles as a log of what the
session has run. `Registry.history` is a fixed ring of `historySize` (500)
entries holding every kind, catalogue reads included — see "The activity log
keeps everything" above. The ring holds only a preview of each statement (300
runes, `sqlTruncated` says it was cut) and of each error (500, `errorTruncated`),
because a ring of editor statements is the one place here where retained strings
could add up. `ClearQueryHistory` empties the ring.

The full text of anything cut is spilled to `<id>.json` in a per-process temp
directory (`ja-db-activity-<pid>-…`, mode 0700, created on first use) and read
back by `QuerySQL` / `api.querySql` when the user asks. A file goes when its
ring slot is overwritten or the log is cleared, so there are never more than 500.
`Service.Shutdown` removes the directory; `activity.New` sweeps directories left
by dead processes (by pid on Unix, by age on Windows). If the directory cannot
be made, the log falls back to a 2000-rune in-memory cut. Only statement text and
the error are written — never bound arguments or row values.

Four things about the tray are deliberate:

- **It never opens itself.** The strip's indeterminate bar is the "something is
  happening" signal; taking over the bottom of the window on every page turn
  would be worse than the problem it solves.
- **Polling is driven by demand, not by a clock.** The store keeps an
  `inFlight` count, incremented around each call that runs SQL. The tray polls
  only while that is non-zero, and once more on the way down so the log ends up
  settled. With history retained, an open tray over an idle app has nothing to
  re-fetch — the list cannot change until the next query — so it fetches
  nothing. Opening the tray or the connections page triggers a single refresh.
- **Timers tick locally.** `elapsedMs` is measured by Go at poll time;
  `frontend/src/activity.ts` adds the time since that response arrived. The
  timer therefore advances every 100ms while the network sees a request every
  700ms. `startedAt` is never used for arithmetic — it is the server's wall
  clock, and skew would show a new query as minutes old.
- **The strip's height never changes.** A query starting must not resize the
  grid, so the strip is fixed and the expanded list is an overlay above it.

Progress is indeterminate by construction: nothing knows how long a query will
take, so the bar shows motion and the timer next to it shows the fact.

## Type handling

`sql.Rows` gives back `[]byte` for most driver types. `internal/driver/scan.go`
normalises everything to a small JSON-safe set — string, number, bool, null — and
records the database's own type name per column separately, so the grid can render a
`NULL` distinctly from an empty string. Binary columns are reported as `\x…` hex with
a byte count rather than shipped to the frontend in full.

## Long values

Text-shaped columns — `text`, `longtext`, `json`, `jsonb`, `nvarchar(max)`, … — are
capped to `textCapChars` (Settings, 1024 by default — roughly the 1 kB DBeaver uses;
0 turns it off). Two layers, and
the first is the one that matters:

1. **In the emitted SQL.** `BuildSelect` replaces `SELECT *` with an explicit column
   list in which long columns are wrapped in the dialect's substring — `LEFT()` in
   MySQL, `left(…::text, n)` in postgres, `SUBSTRING(CAST(… AS nvarchar(max)), 1, n)`
   in SQL Server, `substr()` in SQLite. The server does the cutting, so the megabytes
   never cross the wire. The substring is the one SQL fragment a dialect has to hand
   back, and it goes through the unexported `textCapper` interface rather than
   `Driver`, which stays introspection-shaped.

   Which columns qualify is decided by `isLongTextType` from the introspected type
   name *and the cap in force*: a `varchar(64)` cannot exceed a cap of 1024, so it is
   left alone and the list collapses back to `SELECT *` when nothing qualifies.
   Without column metadata — a view that cannot be introspected — there is nothing to
   rewrite and only layer 2 applies.

2. **While scanning** (`RunQuery`, `QueryOptions.TextCap`). The query asks for
   `cap + 1` characters; that extra character is what tells the scan the value was
   cut, with no second query and no `length()` column per row. The scan trims it and
   records the position in `ResultSet.TruncatedCells`, which the grid marks with a
   `CUT` badge. This layer also covers ad-hoc SQL from the editor, whose statement
   must not be rewritten.

`ReadCell` is the escape hatch: one column of one row, uncapped, bounded by
`MaxCellBytes` (8 MiB). The row is addressed by its absolute offset in the same
filtered, sorted result the grid is showing rather than by primary key, so it works
on a view and on a table with no key — at the cost that on a table being written to
concurrently the offset may have moved. The cell viewer
(`frontend/src/components/CellDialog.tsx`) fetches it on open and renders JSON —
whether the column is `json`/`jsonb` or merely a text column holding some — as a
collapsible tree (`JsonView.tsx`, hand-rolled; see `frontend/src/ui/README.md`).
