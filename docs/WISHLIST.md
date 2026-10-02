# Wishlist

Wanted, not yet built. Each item keeps the original request close to verbatim
so whoever implements it can make their own call against the codebase as it
stands then, rather than following a design decided in advance.

---

## 1. Real server-side query state

The activity tray shows a **status** column — `QUEUED`, `EXECUTING`,
`READING ROWS`, `CANCELLING`, `DONE`, `FAILED`, `CANCELLED`. Those are the
app's own lifecycle, instrumented in `internal/activity`, `internal/driver` and
`internal/api`. They answer "are we waiting on the server or reading rows",
which was the point of asking for the column:

> a column to say the current status of the query like WRITING TO NET etc

What they are *not* is the server's own opinion — MySQL's literal
`writing to net`, `Sending data`, `Locked`; Postgres's `pg_stat_activity.state`
and `wait_event`; SQL Server's `dm_exec_requests.status` plus its blocking
session id. That is strictly better information: it can say *why* a query is
slow, including that it is blocked on someone else's lock.

The cost is a change to how queries are run, which is why it was deferred:

- Each tracked query has to be pinned to its own `*sql.Conn` for its whole
  lifetime, so its connection id can be captured — `CONNECTION_ID()`,
  `pg_backend_pid()`, `@@SPID`. The SQL editor now does this (`runEditor`, for
  cancel) and records `Info.SessionID`; every other kind of query still takes
  any connection from the pool.
- Reading the state then needs a *second* connection, since the first is busy
  running the query being asked about. That is a monitoring connection, and
  it needs its own lifecycle, error handling and permissions story —
  `PROCESSLIST` beyond your own rows needs `PROCESS`, `pg_stat_activity` shows
  other users' queries only to a superuser or `pg_read_all_stats`, and
  `dm_exec_requests` wants `VIEW SERVER STATE`.
- The pinned connection also unlocks a better cancel: `KILL QUERY <id>` /
  `pg_cancel_backend(pid)` reaches queries that context cancellation cannot.
  Built for the editor; it does not yet report whether the kill worked.
- **SQLite has no equivalent at all.** There is no server, no session view. The
  column would have to fall back to the instrumented phases per dialect, which
  means the tray must keep both sources and label which one it is showing.

Worth doing when the tray is being lived in and "why is this slow" becomes the
question. It should not be done by widening the existing pool or by holding a
monitoring connection open for connections nobody is querying.

---

## 2. `ALTER` — change a table that already exists

The object menu can create a table, empty it and drop it. It cannot change one.
Adding a column, renaming one, retyping one, adding or dropping an index or a
foreign key all still mean writing the statement in the SQL editor.

This was left out deliberately rather than forgotten. `CREATE TABLE` is close to
portable across the four dialects — a column list and a table-level primary key
covers it — and `ALTER` is not:

- SQLite has no `ALTER COLUMN` at all. Changing a type means creating a new
  table, copying the rows, dropping the old one and renaming, inside a
  transaction, with the indexes and triggers rebuilt afterwards. `ALTER TABLE …
  RENAME COLUMN` exists but only since 3.25.
- MySQL wants the whole new column definition in `MODIFY COLUMN`, so an edit
  needs everything `DescribeObject` returns and must round-trip it exactly, or
  the change silently drops a default or a collation.
- Postgres separates `TYPE`, `SET DEFAULT`, `DROP DEFAULT` and
  `SET NOT NULL` into different clauses and needs `USING` for a cast it cannot
  infer.
- SQL Server refuses `ALTER COLUMN` outright on a column with an index,
  constraint or default on it — those have to come off first and go back after.

So it is not one feature but four, and the interesting half is the diff: taking
the table as it is, the table as the user has edited it in a form, and working
out the shortest correct sequence of statements per dialect. Worth doing with
the details page as the starting point — it already reads every fact the diff
would need.

Whatever it turns into, it should keep the two rules the create path settled:
the statements are built by the driver and shown before they run, and the action
is in the palette before it is in a menu.

---

## 3. Manual-commit mode in the SQL editor

Asked for alongside the isolation level dropdown, and left out on purpose: a
non-default isolation level wraps each editor run in its own transaction and
commits when the run ends (rollback on error). Real manual commit, as in
DataGrip, would hold a transaction open across runs, with Commit and Rollback
buttons.

That needs a connection pinned to the **tab** for as long as the transaction is
open, not to one run — a held pool slot (the pool is 4), a lifecycle when the
tab closes, the app disconnects or the server drops the session, and an
unmissable "uncommitted changes" indicator that survives tab switches and
blocks closing. Cancel would then also have to decide whether to roll back.
Worth doing only when someone needs a multi-statement edit session across runs.

---

## Built since

- **Manual page size** — a free-text page size beside the presets, as a one-off
  override for the table currently open. `Paginator.tsx`, `pageSize.ts`.
- **Cap long values on read**, and **JSON viewer** — the two items that had to
  be designed together, because a capped value needs a "fetch the whole thing"
  path before there is anything for a viewer to show. Includes the cell context
  menu. See `ARCHITECTURE.md` ("Long values").
- **Autocomplete** — CodeMirror 6 behind `ui/Editor.tsx`, driving both the
  filter box and the SQL editor. Candidates in `src/completion.ts`. Monaco was
  costed and rejected; see `frontend/src/ui/README.md`.
- **The activity tray** — always-visible bottom drawer, query ids, instrumented
  lifecycle status, ticking timers, cancel-with-confirmation, and a bounded
  query log. See `ARCHITECTURE.md` ("The activity tray").
- **Schema changes from the object menu** — create a table, empty it, drop it,
  each a palette action the right-click menu also fires. Statements are built
  per dialect in `internal/driver/ddl.go`. `ALTER` is item 2 above.
- **Themes** — Sherbet, Gruvbox (dark and light) and One Dark, picked from
  Settings or straight from the palette. Nothing but `index.css` knows a
  colour, so a new one is a block of custom properties; see the header of that
  file. Persisted as `theme` in settings.

All five are recorded in full, request verbatim and decisions taken, in
`REQUIREMENTS.md` under 2026-08-17.
