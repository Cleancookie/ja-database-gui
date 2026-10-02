# Requirements log

What was asked for, when, and what was decided. Kept so later work does not
quietly undo earlier work, and so a contradiction between an old requirement
and a new one is noticed rather than silently resolved.

Newest session last. If a new requirement conflicts with something in
**Invariants**, that is a decision to raise, not to make in passing.

---

## 2026-08-16 — initial build

### Brief

> I usually use TablePlus but have since stopped paying for it. Please plan out
> and create a database gui that can achieve similar. I want it to be powered
> by Golang + some kind of Web View UI. I want a command pallete first
> approach. It should support at least: mysql / mariadb, postgres, mssql,
> sqlite

### Decisions taken at the outset

| Question | Choice |
| --- | --- |
| App shell | Wails v2 (WebView2). Windows first, macOS and Linux kept in mind |
| Frontend | React + TypeScript + Vite + Tailwind |
| Scope | Walking skeleton with all four drivers wired |

### MVP features requested

- Connection management, storing multiple connections
- Browse databases on a server
- Browse tables / views / functions / etc. on a database
- Browse rows on a table / view
- `Ctrl+F` filter: a text input that is **raw SQL going after `WHERE`**
- Automatic pagination, with options to turn it off, set per-page, set page number
- SQL editor — plain textarea for MVP, Monaco later, ideally "use your own editor" one day

All delivered. See `ARCHITECTURE.md` for how, and the ADRs for why.

### Test rig

Docker Compose added on request ("could you make a docker compose file for
testing so i have a mysql db"), covering MySQL, MariaDB, PostgreSQL and SQL
Server, seeded with a fixture designed to exercise the failure-prone cases:
bigints past 2^53, decimals, NULL beside empty string, binary columns, a
composite primary key, a table with no primary key at all, and identifiers
needing quoting.

---

## 2026-08-16 — second batch

Requested:

- Settings page on `Ctrl+,`
- Copy-to-clipboard button on error popups
- Right-click menu on connections: connect, disconnect, edit, remove
- Collapsible sidebar sections
- A page showing running queries and open connections, with the ability to cancel
- Databases promoted from a dropdown to its own sidebar section
- Command palette fixed: *"if I search for 'user' expecting to find 'auth.user' … it just shows all the extensions first"*
- Base text size raised — 1rem as the default

All delivered.

### Component library

Asked whether one could help, with the constraint: *"if we do want to use one
lets architect our code we can easily swap it out"*.

Chose **Radix Primitives behind `frontend/src/ui/`** — taken for behaviour, not
styling, because the hand-rolled dialogs had no focus trap or focus restore and
the context menu had no keyboard navigation. Migrated the four dialogs and the
connection menu only. Deliberately left alone: the command palette, the data
grid, and native `<select>`/`<checkbox>`.

### Palette matching

The ranking complaint was fixed twice. First with hand-written match tiers;
then, when it still did not narrow the list enough, by moving scoring to
`fuzzysort` and adding a relative cutoff. Two separate causes were found:
permissive matching, **and** a grouping bug that drew twelve headings for
seventeen results, which by itself read as "nothing was filtered".

### Tooling

`Makefile` added — `make windows` is the headline target. `make check` runs
fmt, vet, typecheck and both test suites.

Pushed to `git@github.com:Cleancookie/ja-db.git`.

---

## 2026-08-17 — long values and the JSON viewer

Wishlist items 2 and 3, taken together because the second needs the first.

### Requested

> dbeaver does a smart thing where long data types such as text, json,
> longtext, etc, are capped at a length so to now cause the UI to lag and also
> the sql request doesn't bog down if there is a table with massive json in it.
> lets also do that for our project.

> another nice feature would be a nice json viewer

### Decided

| Question | Choice |
| --- | --- |
| Where the cap is applied | In the emitted SQL, per dialect (`LEFT`, `left(…::text, n)`, `SUBSTRING(CAST(…))`, `substr`). Trimming after the fetch would save the rendering and none of the bandwidth, which was the bigger of the two wins asked for |
| How a dialect supplies its substring | An unexported `textCapper` interface, not a new `Driver` method — the interface stays introspection-shaped |
| Which columns are capped | Decided from the introspected type name *and the cap*: an unbounded or `(max)` type always, a declared length only when it exceeds the cap. An unrecognised type is left alone rather than risking `substr()` on a number |
| How truncation is made visible | `ResultSet.TruncatedCells`, from asking the server for `cap + 1` characters and noticing the extra one. Grid marks those cells `CUT` |
| How the full value is fetched | `ReadCell`: one column of one row, addressed by absolute offset in the same filtered, sorted result. Works on views and keyless tables, unlike a primary-key lookup. Bounded at 8 MiB |
| Configurability | `textCapChars` in Settings, 1024 by default (the ~1 kB DBeaver uses, which is the number that was asked for), 0 to disable. Saving a new cap re-reads the open table |
| JSON viewer | Hand-rolled collapsible tree (`JsonView.tsx`), no new dependency. Opens on Enter or double-click, on JSON/JSONB columns and on text columns that happen to hold JSON |

Verified against real MySQL, PostgreSQL and SQL Server containers as well as the
SQLite-backed unit tests, because a wrong substring is a syntax error only the
server can report.

### Follow-up, same day

The request restated, with two specifics: *"in dbeaver it limits it to just 1kb
of data I think"*, and *"maybe we could add a right click context when we right
click on a cell to open in the cell viewer"*.

- Default cap moved 512 → **1024**. Defaults only: a settings file that already
  names a cap keeps it, and one written before the feature existed picks up the
  new default.
- **Right-click menu on a grid cell** — open in cell viewer, copy value, copy
  full value (uncapped, disabled when the shown value already is whole), copy
  column name. Behind `ui/Menu.tsx`'s existing Radix wrapper, which gained only
  an optional separator.
- One menu wraps the row area rather than one per cell: a Radix root per
  rendered cell would be hundreds in a virtualised grid. Right-click selects the
  cell first, so the menu always acts on what was clicked. `Enter`, double-click
  and the platform menu key all reach the same viewer.

---

## 2026-08-17 — always-visible query activity

### Brief

> also can you add an item such that it is a loading bar so I know it's doing
> something? or maybe we should make the currently running queries visible
> somewhere maybe a folding bottom tray like on tableplus with a loading bar /
> timer on each query

Delivered as `frontend/src/components/ActivityTray.tsx`: a strip along the
bottom on every view, collapsed by default, ``Ctrl+` `` to expand. The strip says
how many queries are running and how long the oldest has been going; expanded,
each query gets a ticking timer, an indeterminate bar and a Cancel.

### Decisions

| Question | Choice |
| --- | --- |
| Tray or page? | **Both, split by shape.** The tray owns in-flight queries; the activity page keeps the server-side pools, renamed "Open connections" |
| Progress semantics | Indeterminate only. A query's duration is not knowable up front and a fabricated percentage would be a lie |
| Cost when idle | The store counts in-flight API calls; the tray polls only while that is non-zero, the tray is open, or the connections page is on screen. An untouched app issues nothing |
| Timer smoothness | Poll at 700ms, tick locally at 100ms from the last snapshot. Never recompute from `startedAt` — that is the server's clock |
| Layout | The expanded list is an overlay, so starting a query never resizes the grid |

The header's old "N running" button went away: the strip says the same thing
permanently, and two indicators for one fact drift apart.

### Second pass, same session

> I was thinking a one line preview of the query, maybe a query ID, and then a
> column to say the current status of the query like WRITING TO NET etc, and
> also how long it has been running for and maybe a cancel button (that
> requires confirmation) once the query is done it will auto hide maybe, or
> maybe this query should stay in this pane always so there is a history of
> queries and then we show the pane when there is a running query?

Answers given by the user when asked:

| Question | Choice |
| --- | --- |
| Real server state (`writing to net`) or the app's own phases? | The app's own, instrumented. Real engine state deferred — wishlist item 4 |
| Auto-hide, or keep a history? | Keep a history, with the final duration and a terminal status |
| Auto-open the pane when a query starts? | **No.** The strip's bar is signal enough |

Delivered: a query id column (`q001`, zero-padded so the column does not
change width), a status column from real instrumentation, a bounded history
ring (200 entries then, 500 now), `Clear log`, and a confirmation on Cancel that honours the
existing "confirm destructive actions" setting.

Catalogue reads were shown while they ran but not retained in the history: they
fire on every table open and would push the user's own queries out of the ring
within a minute. *Superseded:* every kind is retained now, in a ring of 500, and
the tray hides catalogue reads from the view instead — see `ARCHITECTURE.md`,
"The activity log keeps everything", and `historySize` in
`internal/activity/registry.go`.

---

## 2026-08-17 — autocomplete, and the editor decision

### Requested

> I want auto complete help when I'm writing the where filter on tables or
> maybe on the sql editor. maybe it's time for monaco editor? think about the
> future too.

Plus, separately: the cell viewer's text was too small against the global
style. Fixed by moving the value body and the JSON tree to `0.875rem` — larger
than the grid's `0.75rem` on purpose, because the grid is dense to show
hundreds of rows and the viewer shows one value someone stopped to read. Still
in rem, so the root-size knob in Settings scales it.

### Decided

| Question | Choice |
| --- | --- |
| Which editor | **CodeMirror 6**, not Monaco. Monaco is megabytes and wants a web worker, which is awkward with assets embedded in a Wails binary. CodeMirror is modular, worker-free, and ships per-dialect SQL |
| Measured cost | 120 kB gzipped. Loaded on demand, so the **startup** chunk is 126 kB against 124 kB before the editor existed |
| Lazy-load it? | **Yes** — `ui/LazyEditor.tsx`. Decided after the user reported a slower launch. At launch neither surface that uses the editor is mounted: the filter bar renders only once a table is open, the SQL editor only on the SQL view. Eager loading made every launch pay for something many sessions never touch. `ui/index.ts` must keep exporting the lazy wrapper or the split is silently undone |
| Where the vendor lives | `frontend/src/ui/Editor.tsx` only, per the house rule. The narrow API is value/onChange/onSubmit/onCancel/singleLine/dialect/completion; no CodeMirror type is exported |
| What can be completed | `src/completion.ts` — plain data, no editor API, so the candidate rules are unit-tested without a DOM |
| Ranking | Columns of the open table first (primary key above its siblings), then tables and views, then functions, then keywords. A predicate is overwhelmingly about the columns in front of you |
| Filter box candidates | Columns, predicate keywords, dialect functions — **no table names**, since the table is already chosen and offering it only pushes the columns down |
| Editor candidates | The above plus objects in the database and statement keywords. Columns are still the open table's: knowing which table a half-typed statement means would need parsing, so the detail text names the table each column came from rather than pretending |
| Key handling | Enter (filter) and Ctrl+Enter (editor) submit *only* when the popup is closed; Escape closes the popup first and reverts the filter second. Tab accepts a completion, else indents |
| Caret inside a string literal | No popup at all. Completing a column name into `'act…'` would be wrong every time |

### Startup timing, same day

> also my app takes a while to launch now. could we debug why? or maybe we just
> add some logging in so you can investigate later

The editor was the cause and is fixed by the lazy split above. Instrumentation
was added anyway, because launch feel cannot be measured from a test: `main.go`
logs config-loaded and webview-ready elapsed, and `frontend/src/startup.ts`
marks script-start, react-mount and config-loaded. The first frontend mark is
itself the measurement of webview boot plus bundle parse.

Reported through a palette command ("Show startup timing") as well as the
console, because the Windows build is launched from Explorer where there is no
console to read.

`focusFilter` had to change: the filter is no longer an `<input>`, so focusing
it through `document.getElementById` would land on a div. The editor registers a
focus handle (`registerFilterFocus`) and Ctrl+F calls through it.

---

## 2026-08-18 — schema changes from the object menu

### Requested

Context menus for tables: truncate, drop, create a new table, and right-click
to view table details (details was already there from the previous session).

The instruction that shaped the build: make these **actions first**, reachable
from the command palette, and hang the UI off them. A menu item is a second
route to an action, never a second implementation.

### Decided

| Question | Choice |
| --- | --- |
| Where the statements are built | Per dialect, behind three new `Driver` methods (`BuildTruncate`, `BuildDrop`, `BuildCreateTable`) with the portable parts in `internal/driver/ddl.go`. The alternative — assembling DDL in the frontend — would have put quoting and the SQL Server `CREATE` problem in the one place that cannot be unit-tested cheaply |
| SQLite's missing `TRUNCATE` | `DELETE FROM`, advertised through `Capabilities.TruncateIsDelete` so the confirmation names the statement it is actually about to run. The two are not interchangeable: `DELETE` fires triggers and rolls back |
| `TRUNCATE … CASCADE` / `DROP … CASCADE` | **Neither.** Postgres refusing to truncate a referenced table is information, and the menu must never empty a table the user did not name |
| SQL Server `CREATE TABLE` | Sent through the target database's own `sp_executesql`. `CREATE` accepts a database qualifier only when it names the *current* database, and this driver reaches other databases by qualifying rather than switching. A `USE` prefix would work and then leave the pooled connection pointing somewhere else for the next caller |
| Column types in the new-table dialog | Free text, with the dialect's usual spellings offered as suggestions from `Capabilities.CommonTypes`. A closed dropdown cannot cover `numeric(10,2)`, `nvarchar(max)` and `bigint AUTO_INCREMENT`, and would be a permanent source of "the type I want is missing" |
| Types and defaults as raw fragments | Accepted, on the same terms as the row filter (`docs/adr/0002`). Guarded only against a semicolon or a comment, so a typo cannot append a second statement |
| Where confirmation lives | In the store action, not the call site. `truncateTable` / `dropObject` decide whether a confirmation is owed; `runTruncate` / `runDrop` are what the dialog calls. Splitting it is what stops one route confirming and another not |
| The `CREATE` preview | Rendered by the driver through `PreviewCreateTable`, which runs no SQL and is not logged. A preview assembled by different code from the one that executes would eventually be a lie |
| Activity log | New `ddl` query kind. An irreversible statement is exactly the one worth finding in the log afterwards |

## 2026-08-26 — a click that lands, and the double-click

### Brief

> why does the datatable feel so laggy? when i click it takes a few seconds for
> a cell to select. also can we make it so double clicking on a cell doesn't
> pop the cell viewer it would be nice to just select the text. we should add
> it to the context menu (right click, open cell viewer)

### Decided

| Question | Choice |
| --- | --- |
| Cause of the lag | `useCellMenu` subscribed to the *selection*. It is held by `App` and by `SqlEditor`, so every cell click re-rendered the whole shell — sidebar included (now the tab strip and picker), and the sidebar's object list is unvirtualised with one Radix menu root per table. Moving a one-cell highlight was doing a few hundred menu roots' worth of work |
| Fix | The hook reads the store with `getState` and returns a builder that is stable for the life of the component. Correct because the builder only ever runs while the menu is rendering, so `getState` is already current state |
| Second fix | `Sidebar` (now `Picker`, and `TabStrip`) is `memo`'d. It takes no props and is the most expensive thing on screen, so no parent re-render should ever cost anything |
| Double-click | No longer opens the cell viewer. It selects the text inside the cell, which is what a double-click means everywhere else |
| How the viewer is reached now | `Enter`, the platform menu key, and **Open in cell viewer** at the top of the right-click menu — which was already there from the 2026-08-17 session, so nothing new was added, only the double-click removed |

This reverses "`Enter`, double-click and the platform menu key all reach the
same viewer" from 2026-08-17. Deliberately: text selection inside a cell is
worth more than a third route to a dialog that already has two.

### Follow-up, same day

> pressing tab on the datatable is also laggy can we inspect that and try to
> fix it? if it's the same thing as clicking on cells from earlier maybe we
> should scan around to see what else might be prone to the same thing

The scan was every `useStore` subscription against how high in the tree it
sits. Two more of the same shape, and the work Tab was repeating:

| Found | Fix |
| --- | --- |
| `SqlEditor` subscribes to `sqlText`, so it re-renders on every keystroke — and handed `DataGrid` a fresh inline `onOpenCell` arrow each time, repainting the whole result while the user types | `DataGrid` is `memo`'d and both call sites pass `useCallback` handlers. Its other props are already stable store references |
| `App` subscribes to `busy`, `dialog` and `page`, all of which change without the grid's contents changing | Same fix. The memo only holds because the inline arrows are gone — one unstable prop would void it |
| Tab re-measured the sample on every flip: the transposed grid computed its label and record widths in its own `useMemo`, and it mounts fresh each time | One sizing pass in `DataGrid`, above the orientation switch, handed down as props. `DataGrid` stays mounted across a transpose, so the memo survives it |
| The cell menu was rebuilt on every render of the grid, scanning `truncatedCells` to decide whether the cell was cut | `useMemo` on the focus. A repaint cannot change the answer |

Tab still re-mounts the other orientation, which is irreducible — it is a
different component with a different DOM. What is gone is the measuring.

Not done, and the next thing to look at if the transposed grid still drags: it
gives every row its own `position: sticky` column-name cell, so a wide result is
tens of sticky constraints inside a very wide scroller. One absolutely
positioned overlay column would be one.

## 2026-08-26 — a palette that keeps up, and column widths

### Brief

> the command palette is slow if there are LOADS of results. one my databases
> has thousands of tables. is there any way to make this faster? also pressing
> tab on the datatable still feels slow, is it possible to have it to less
> calculations? maybe we make it like excel column sizing where the user can
> resize it but they are all fixed width by default or whatever needs fewer
> calculations and then double clicking the first resizer … it will calculate
> and resize all the columns?

### The palette

Measured this time, on 5000 objects, before deciding anything:

| Found | Fix |
| --- | --- |
| Ranking copied fuzzysort's matched indices into a JS array for every candidate — and that copy costs more than the matching. Only the two hundred rendered rows can use them | Scoring and highlighting are separate calls: `matchScore` while ranking, `matchPositions` per visible row. `"cus"` 8.5ms → 3.8ms, `"order_line"` 9.8ms → 4.3ms |
| Every keystroke re-rendered all two hundred rows, and so did every *pixel* of pointer movement across the list — the rows used `mousemove` | Rows are memoised on stable props and hover is `mouseenter`. An arrow key now re-renders two rows |
| Grouping ran over every match before the list was cut to two hundred | Cut first, group after. 0.59ms → 0.03ms |
| `orderByRecency` built a key string inside its comparator, so O(n log n) of them | Decorate, sort, undecorate. Worth ~15% of the sort — recorded because the shape is right, not because it was the bottleneck |

`fuzzysort.go` with `keys` and a bounded `limit` was measured too and is *slower*
than the above in every case but "nothing matches" — its own prepared-target
cache already covers the part that looked expensive.

### Column widths

The premise did not survive checking: auto-sizing already ran once per result
rather than once per Tab — that was fixed earlier the same day by hoisting the
sizing pass above the orientation switch. So fixed-width defaults would have
bought nothing on Tab, and the auto-sized default stays.

What was built instead is the rest of the request, as a capability in its own
right:

| Gesture | Effect |
| --- | --- |
| Drag a column's right edge | Resizes it, up to four times the default cap |
| Double-click a column's right edge | Fits it to the widest sampled value, *past* that cap — the cap exists to keep the opening layout sane, not to refuse the ask |
| Double-click the edge right of the row-number gutter | Fits every column at once |
| Header right-click → Reset column widths | Back to the measured defaults |

Widths are keyed by column *name*, not index, so a reload or a page turn cannot
hand a column somebody else's width. The transposed grid is deliberately left
alone: it gives every record one uniform width on purpose, and per-record
resizing would undo the thing that makes a wide row readable.

The handles are mouse-only. A couple of hundred focusable separators would
swallow keyboard traversal of the grid, and `Tab` already means "transpose"
here.

## 2026-08-26 — dragging selects cells, not the line

### Brief

> can we make it so you can only select the text in one cell and not the whole
> line in the datatable? if i can dragging I probably want to be selecting
> multiple cells and if i copy them I probably want a csv of those cells […] if
> it's all one column then i probably want to just copy the values

### Decided

Most of the brief was already built: the clipboard formats — one cell verbatim,
one column as an `IN` list, anything wider as CSV with a header row — have been
in `frontend/src/selection.ts` since the range-selection work, and nothing about
them changed here. The gap was the *gesture*: a range could only be built by
shift-clicking or by shift-arrows, so a drag fell through to the browser and
painted a text selection straight across the row.

| Question | Choice |
| --- | --- |
| Drag inside one cell | Still an ordinary text selection. That is what a drag means everywhere else, and taking it away for the common case buys nothing |
| Drag that crosses into a second cell | Switches meaning: the half-made text selection is dropped, the grid stops selecting text for the rest of the gesture, and each cell entered extends the range |
| Where the switch lives | `useCellDrag` in `DataGrid.tsx`, shared by both orientations. `mouseup` is watched on the window — a drag very often ends outside the grid, and a gesture that never ends leaves every later hover extending the range |
| `IN` list separator | Left as `', '`. Readable in a `WHERE` clause, and the space is not what makes it paste |

Not built: auto-scroll when a drag reaches the viewport edge. A drag is limited
to the cells on screen; shift-click still covers the long range.

## 2026-08-27 — right-click in the JSON tree

### Brief

> can we upgrade the json viewer? I want to be able to right click on a key name
> to bring up a context menu. I want to copy the key name or maybe the key path
> or value etc. If I click click on a value I might want to copy the value or key
> or key path etc

### Decided

| Question | Choice |
| --- | --- |
| Path notation | JSONPath — `$.users[0].address.postcode`. Chosen over dotted, bracket-only and dialect-specific arrow forms because it pastes into `jsonb_path_query` and most JSON tooling unchanged. Object keys are dotted when they are bare identifiers, `['quoted']` otherwise — a key holding a dot or a space would otherwise build a path that addresses something else |
| Where the path comes from | Built on the way *down* the tree, one segment per `Node`, by `jsonPathChild` in `json.ts`. No second walk to find a node's own path |
| One menu or two | One. Right-clicking a key and right-clicking a value give the same four items, because both things you might want are on it either way and making the reader aim at the key buys nothing |
| Number of Radix roots | One for the whole tree, with the clicked node in state — the arrangement `DataGrid` already uses. A root per node is hundreds of them in a document of any size |
| `Copy value` on a string | The bare text, without quotes: someone copying a postcode wants to paste a postcode. `Copy value as JSON` keeps the quotes and escapes, and is disabled where the two would be identical (numbers, booleans, null, containers) so the menu keeps its shape between nodes |
| Stale targets | Cleared when the value prop changes — the dialog swaps in the full document once a cut cell finishes fetching, and a target left pointing into the old one would copy data no longer on screen |

Not built: keyboard equivalents on the tree rows, and palette entries. Both would
need a focus model the tree does not have — it is a set of toggle buttons, not a
grid with a cursor.

## 2026-09-30 — editing rows in the grid (backend)

### Brief

Edit rows in the data grid. This entry is the Go side only; the grid UI follows.

### Decided

| Question | Choice |
| --- | --- |
| How edits reach the database | As a staged *change set* — `RowChange`s of `update`, `insert` or `delete` — sent to `PreviewChanges` (shows the SQL, runs nothing) and then `ApplyChanges`. Nothing is written as the user types |
| Which columns address a row | `ReadRowsResult.EditKey`: the primary key, else the first unique index that is complete and all NOT NULL, else the table is read-only with a `ReadOnlyReason`. The WHERE is the key alone, with the *original* values |
| What is read-only | Views; tables with no usable key; per column, generated, binary (the wire value is a lossy hex preview) and — SQL Server — identity and rowversion. Reported per column as `GridColumn.Editable` |
| Stale rows | Every update and delete must affect exactly 1 row. 0 means the row changed or went away since it was loaded; more than 1 means the key was not unique. Either rolls the whole change set back and is returned as `ApplyResult.Conflict` |
| Atomicity | One transaction per `ApplyChanges`; all or nothing |
| Values | Bound parameters, coerced by the column's declared type; `CellValue.Kind` keeps `value`, `null` and `default` apart so NULL is never `''` |
| `SET col = DEFAULT` on SQLite | Refused for an update (no such keyword); left out of an insert, which means the same. `Capabilities.SetToDefault` tells the UI |
| Preview vs apply | One builder, `planChanges` → `Driver.BuildChange`. `Statement.Display` is the same statement with literals written in and is never executed |
| Activity log | New `write` kind. The logged SQL is the parameterised text; the values are not logged |

Not done here: the UI, and editing columns that are read-only above.

## 2026-09-30 — editing rows in the grid (frontend)

### Brief

The grid UI for the change-set API above. Hard requirements as given: edits are
staged and visibly dirty; nothing runs until the user asks; Accept, Preview and
`Ctrl+S` all open one review listing every statement; only its Run button
writes; a refusal keeps the dialog open; staged edits are never dropped silently.

### Decided

| Question | Choice |
| --- | --- |
| Where the rules live | `frontend/src/edits.ts`, pure and unit-tested: staged state keyed by the JSON of the row's *original* key values, never by row index, plus `toChangesRequest`. `storeEdits.ts` is the store half; `useGridEdits.ts` draws edits over the loaded result without altering it |
| Who may write | `applyStaged`, called from `ReviewChangesDialog`'s Run button and nowhere else. `reviewChanges` (Accept, Preview, `Ctrl+S`) builds and shows the SQL and runs nothing. `invariants.test.ts` reads the source and fails on a second caller |
| Applying what was shown | Run sends the `ChangesRequest` that was previewed, held in `review.request`, not a fresh build from whatever is staged now |
| After a refusal | Dialog stays open, the message is shown, the failing statement is marked and Run is disabled. Nothing was written, so the way out is Cancel, fix, review again |
| Losing work | *Superseded below (2026-09-30 round 2): edits are kept across page, sort, filter, refresh and table switches; only disconnecting their connection or truncating/dropping their table asks or clears.* A browser reload or close asks through `beforeunload` |
| Discard | Immediate below 5 staged changes (`Ctrl+Z` covers them), a confirmation from 5 up |
| Editing a capped cell | `F2` fetches the whole value with `readCell` first and opens the editor only when it arrives. Saving the 1024-character preview over the real value is the failure this prevents. Over 8 MiB it refuses |
| NULL vs `''` | The editor starts empty for both and only a typed change stages anything, so `F2` then `Enter` on a NULL cell changes nothing. `Ctrl+Backspace` stages NULL; the grid draws NULL, `empty` and `DEFAULT` differently |
| Key cells | Editable. The change's key always holds the original values |
| Order of statements | Deletes, then updates, then inserts, so a row can be replaced by an insert that reuses its key |
| Insert rows | Drawn after the page, marked `+`, unset cells shown as `DEFAULT` |

### Round 2 — several tables, one status strip, big values

User feedback on the first pass, all taken.

| Question | Choice |
| --- | --- |
| Where the bar lives | Not over the grid. `ChangesStatus` sits on the activity strip at the bottom, which is on every view: "N staged changes in M tables", Accept (`Ctrl+S`), Preview, Discard. It subscribes to `stagedSummary`, a derived value the store keeps the same object until a count moves, and is mounted by `ActivityTray`, so `App` never re-renders for an edit |
| Staging per table | `edits.ts` holds `tables` keyed by connection, database, schema and name, each with its own row-keyed `EditSet`, plus the order the tables were first edited. One flat `changes[]` is built in that order; each change carries its `ref` |
| One transaction | All staged changes must share one connection and one database. Staging in another is refused with "Apply or discard N staged changes in conn/db first" (`scopeClash`); the set is never silently split |
| Losing work | Staged edits survive page, sort, filter, refresh and table switches, because they are keyed by row, not position. `holdForDiscard` remains for disconnecting the connection they belong to; truncating or dropping a table forgets that table's edits, after the confirmation that already says its rows go |
| The review | One dialog, grouped by table, statements numbered by their flat index (that is what a conflict names). Each shows `Statement.short`; "Show full" mounts the whole `display` in a scrollable box on request, "Copy SQL" copies it without showing it, and chips give each column's character count, NULL or DEFAULT |
| Big values | `F2` opens `CellEditDialog` — near-full-window CodeMirror with line numbers, wrapping and JSON highlighting — for a value over 200 characters, with a newline, in a json/xml column, or capped; `Shift+F2` forces it. The document stays in CodeMirror and is read once on Stage. A capped cell shows a loading state and never edits truncated text |
| JSON in the editor | Valid/invalid readout, Format and Minify. Those rewrite only the whitespace between tokens (`reformatJson`): parse-and-stringify would round a 20-digit integer, turn `1.0` into `1` and drop a repeated key. Only a json/jsonb column refuses to stage invalid JSON; a text column may hold anything |
| Markers | Dirty cells as before; a gutter dot on rows (accent edit, red delete, green new) in both orientations; a dot on each picker table and each tab through `TableMark`, which subscribes to a boolean for its own key so staging re-renders only the row that flipped; `Go to next changed table` in the palette and on the status label |
| Esc in the big editor | With unsaved text it asks once, inline in the dialog rather than in a second modal |

Measured on a 4000-table SQLite file: staging five cell edits re-rendered no
`TableMark`, the first edit on a table re-rendered two (its own), and moving
the selection 40 times re-rendered none. Rebuilding the whole list while typing in
the object filter costs about 12% more with the 4000 marks mounted (≈640 ms vs
≈575 ms for the same keystrokes).

Not built: **Duplicate row** (YAGNI — a copied key is a conflict waiting to happen and the
brief allowed skipping it), editing in the SQL editor's results (no table behind them),
and a guard on closing the native Wails window (the webview's `beforeunload` does not
fire there; it needs `OnBeforeClose` and a dirty flag pushed to Go).

## 2026-09-30 — one change set across several tables

### Decided

| Question | Choice |
| --- | --- |
| Shape | `RowChange.Ref` replaces `ChangesRequest.Ref`: `ChangesRequest{ConnectionID, Changes}`. Each change is validated against its own table's key, columns and read-only facts |
| Reach | Several tables of one connection and **one database**. A ref in another database is refused before anything runs, because the transaction is on one session |
| Atomicity | Unchanged: one transaction, statements in the order given, exactly 1 row each, all or nothing. `ChangeConflict.Index` is into the flat list; `ChangeConflict.Table` names the table |
| Grouping | `Statement.Table` (qualified name) so the review can group by table |
| Activity log | One `write` entry per transaction, text led by `-- N changes across M tables` |
| Huge values | `Statement.Short`: `Display` with string literals over 160 characters cut to 160 and ended `…(+N more chars)` inside the quotes. Built by the same template, capped when the literal is rendered, before dialect quoting, so an escape is never split. `Display` stays whole |
| Size of a cell | `Statement.Cells`: column, kind (`value`, `null`, `default`) and character count of the new text |

## 2026-10-01 — tabs replace the sidebar

### Brief

Almost all of a session was spent in the main pane; the sidebar was used for the first half-minute and then left alone. Make the left rail a vertical tab strip, with a picker as what a new tab shows.

### Decided

| Question | Choice |
| --- | --- |
| What a tab is | A table with its filter, sort, page and selection, plus the tab's own SQL editor and details page. Activity stays a global tray |
| Picker | A centred accordion: connection, then database (skipped for SQLite), then table. Choosing collapses the step to a summary and opens the next; a finished step reopens from its header. Connections have visible edit and remove buttons and a New connection row. Arrows or `Ctrl+J` / `Ctrl+K` move a highlight through the open step, Enter takes it (a filter resets it to the first match). Shared with the palette through `listNav.ts` |
| `Ctrl+P` | Retargets the current tab. Open tabs are listed in the same palette to jump to |
| Keys | `Ctrl+T` new, `Ctrl+W` close, `Ctrl+Shift+T` reopens the last ten closed (not bare pickers), `Ctrl+Tab` / `Ctrl+Shift+Tab` and `Ctrl+PageDown` / `PageUp` cycle. All in the action palette too |
| Pages | The main panel shows picker, table, SQL editor, details or activity. Every change of page, including a tab switch, is recorded (up to 100) by a store subscription |
| Mouse | Back / forward walk those pages across tabs, restoring a table's filter, sort and page. With Shift they cycle tabs |
| Tab strip | `Ctrl+B` or `Ctrl+←` hides or shows it (`Ctrl+↓` toggles the activity tray, as `` Ctrl+` `` does; both skipped while typing); persisted as `tabStripHidden` |
| Persistence | None. The app starts on the picker |
| Staged edits | Global, as before. Two tabs on one table share pending edits |
| Closing the last tab | Leaves a blank one |
| Disconnect, drop | Blank every tab on that connection, or showing that table |

## 2026-10-01 — infinite scroll, drawer speed

### Decided

| Question | Choice |
| --- | --- |
| Infinite scroll | Setting `infiniteScroll`, also a palette toggle. Needs pagination on: the page size is the chunk. When the last row of the browse grid is in view, the next page is appended below it. The SQL editor's result is unaffected |
| What `page` means | Pages loaded so far. A refresh asks for page 1 at `pageSize × page` rows, so what was on screen is kept; a new sort, filter or table resets to 1 |
| Next page | By position, not by offset: the read returns `next`, the sort-column values of its last row, and the append sends it back as `after`. Rows added or removed above cannot then repeat or skip one. Falls back to the offset where the sort cannot be compared exactly |
| Scroll and selection | The grid scrolls to the top and clears the selection when the *column list* changes, not when rows are appended |
| Limits | Stops at `rowCap`. The total is not re-counted on append |
| Page controls | Hidden; the bar says Scroll for more / Loading more… / End of results. the page commands are inert |
| Drawer speed | Setting `drawerDurationMs` (0–2000, default 260, 0 is off), applied as `--drawer-duration` and previewed live in Settings. The tab strip and the activity tray both use it |

## 2026-10-01 — paging by position

### Decided

| Question | Choice |
| --- | --- |
| Problem | `LIMIT/OFFSET` counts from the top on every read. A row inserted above the window repeats one at the next page; a delete skips one. Newest-first on a growing table does it constantly |
| Tiebreaker | Every read is ordered by the requested sort **plus the missing key columns, ascending** (`driver.StableOrder`), paged or not. Rows that tie on the sort no longer swap places between pages. The UI is told the requested sort only, so the header is unchanged. An emptied sort therefore reads in key order |
| By position | `ReadRowsResult.Next` is the last row's sort-column values; `ReadRowsRequest.After` sends them back. `driver.BuildRead` adds `(a > ?) OR (a = ? AND id > ?)` — a chain, not a tuple, because directions can differ and SQL Server has no row values — with the values bound, and the filter parenthesised. The activity log shows it with the values filled in |
| When not offered | No key; a sort column that is nullable (a key column never is), a float (the value travels as text), or a binary preview; or the last row's sort value was cut by the text cap. `Next` is then absent and the UI counts pages as before |
| Where it is used | Infinite scroll's append only. Paged mode still counts pages: a page number is a position the user chose |
| Full-value fetch | `ReadCell` finds the row by its key when the table has one, falling back to the offset. An offset names a position, and positions move; infinite scroll also made the old arithmetic wrong, since `page` there counts what is loaded |

## 2026-10-02 — TLS defaults (security audit B1-B3)

### Decided

| Question | Choice |
| --- | --- |
| Default for a connection with no SSL mode | Off this machine: verified (`verify-full` / `tls=true` / `encrypt=true` with the certificate checked). On loopback: the old behaviour or better (`prefer` / `preferred` / SQL Server trusting its own certificate). `docs/adr/0008` |
| **Existing saved connections** | All have an empty mode, so a **remote** one now verifies. Self-signed or TLS-less remote servers fail to connect until an SSL mode is picked (and, on SQL Server, the trust box ticked). Nothing is rewritten on disk; the error names the setting. Loopback connections are unaffected |
| Allowed modes | An allow-list per dialect in `Capabilities.SSLModes`, enforced in `DSN` and on save |
| `Params` | May not carry `sslmode`, `tls`, `encrypt` or `TrustServerCertificate` (any case) |
| Skipping certificate checks | SQL Server only, `trustServerCertificate`, an explicit checkbox with a warning |
| Visibility | The form shows the resolved mode; the Picker tags each connection `TLS`, `TLS unverified`, `TLS optional` or `no TLS`. Remote plaintext is red |


## 2026-10-02 — security audit, the rest of part B

### Decided

| Question | Choice |
| --- | --- |
| Dev server | Host and Origin must name this machine, on any port (`localhost`, `127.0.0.1`, `[::1]`). The Vite proxy forwards the browser's Host unchanged, so `make web` still works; a LAN or WSL-IP hostname does not. Body capped at 64 MB; headers must arrive in 10 s. No token |
| CSV | The **file** export prefixes `'` to a cell starting `= + - @ tab CR`, header names included, bare numbers excepted. The clipboard copy is byte-faithful, so the two now differ for such cells |
| MySQL DSN | Built with `mysql.Config.FormatDSN` |
| SQLite | File path escaped in the `file:` URI; `trusted_schema` off. A non-existent path is still created |
| Logging | Server errors and webview lines are quoted and capped at 300 characters |
| Result size | A result stops at 256 MB of cell data and reads as truncated, like the row cap |
| CSP | Header from the Wails asset middleware: same-origin scripts and connections, inline styles allowed |
| Build | `npm ci` from the lockfile; SQL Server test image pinned by digest; `make vuln` before a release |

## 2026-10-02 — SQL editor: click area, cancel, isolation level

### Brief

1. Clicking the empty part of the editor pane did nothing; only the placeholder line took focus.
2. A Cancel separate from Run, working on every dialect.
3. A DataGrip-style isolation level dropdown.

### Decided: click area

| Question | Choice |
| --- | --- |
| Where | `focusEditorFromPane` on the pane wrapper in `SqlEditor.tsx`. A press outside `.cm-editor` focuses the editor with the caret at the end (`EditorHandle.focusEnd`) |
| Left alone | Presses inside the editor (selection), on the pane's scrollbar (`paneClick.ts`), and the Resizer, which is a sibling of the pane |

### Decided: cancel

| Question | Choice |
| --- | --- |
| Surface | A Cancel button in the editor toolbar while an editor run is in flight, beside Run and not a toggle of it. Hotkey `Ctrl+.` (no CodeMirror or app binding uses it; Escape already closes popups and the palette). Palette: "Cancel running query" and "Cancel all running queries on this connection" |
| API | `CancelSQL(connectionId, database)` stops the editor's statements on that target. `CancelConnectionQueries(connectionId)` stops everything on the connection. Both in `internal/api`, both in `app.go` and `cmd/devserver` |
| Pinned connection | Every editor run takes one `*sql.Conn` (`runEditor`). Its server session id is read first and recorded on the activity entry (`Info.SessionID`) |
| Order | Kill on a second pool connection, then cancel the context. The other way round drops the socket first |
| Safety | The kill is armed only between capture and release (`activity.SetSession` / `ClearSession`) and `ClearSession` waits for a kill in flight, so it cannot reach a session that has moved on. The statement is `fmt.Sprintf` of an `int64` the server returned for our own connection. Nothing else can name a session |

What cancelling the context does on the server, read from the driver source at the versions in `go.mod`:

| Dialect | Context cancel alone | Kill added |
| --- | --- | --- |
| SQLite | modernc interrupts the statement. Stops | none |
| SQL Server | go-mssqldb sends a TDS attention packet; the server aborts the batch. Stops | none. `KILL` needs ALTER ANY CONNECTION and ends the session |
| PostgreSQL | pgx expires the socket deadline, closes the connection and sends a cancel request from a new socket. Best effort and asynchronous. **Live: stopped the server's `pg_sleep` on its own** | `pg_cancel_backend(pid)`, as a deterministic second layer |
| MySQL / MariaDB | go-sql-driver only closes the socket. The server keeps running the statement until it next writes. **Live: `SLEEP(61)` was still in the process list 2 s after a bare cancel** | `KILL QUERY <id>`; live, the same statement was gone 1 s after Cancel |

Checked live against MySQL 8.4 and PostgreSQL 17 with the opt-in `internal/api/live_test.go` (`JADB_LIVE=mysql|postgres`, see the file header). SQL Server was read from the driver source only, and MariaDB shares the MySQL driver and `KILL QUERY` but was not run.

### Decided: isolation level

| Question | Choice |
| --- | --- |
| Levels | Driver default (the default), read uncommitted, read committed, repeatable read, serializable, and snapshot on SQL Server. `Capabilities.IsolationLevels` per dialect; empty on SQLite, which hides the dropdown |
| Mechanism | A non-default level runs the editor statement on the pinned connection inside `BeginTx(ctx, {Isolation})`. Commit at the end of the run, rollback on error. Driver default keeps the untransacted path. `SET SESSION` is not used: a pool makes it unreliable |
| Allow-list | The request carries a name. `driver.IsolationFor` maps it to a Go constant and refuses anything not in that dialect's list. The name never reaches SQL |
| Scope | Per tab (`TAB_FIELDS`), not persisted |
| Verified live | MySQL 8.4 and PostgreSQL 17 report the requested level inside the run (`TestLiveIsolationLevelsApply`), the session level is untouched afterwards, and PostgreSQL `VACUUM` is refused inside a run and works on the default path. SQL Server was not run; its driver maps the same constants, `snapshot` included |
| Warning | The tooltip says each run is wrapped in a transaction, so statements that cannot run in one (PostgreSQL `VACUUM`, `CREATE DATABASE`) will error |
| Not built | Manual-commit mode. See the wishlist |


## Invariants

Things that are true on purpose. Breaking one should be a decision, not an
accident. Where a test enforces it, changing the behaviour means changing a
test — which is the intended speed bump.

### Data correctness

| Invariant | Enforced by |
| --- | --- |
| Integers beyond 2^53 are sent as strings — a JSON number silently rounds a bigint id | `internal/driver/scan_test.go` |
| Decimals stay strings; never float64 | `scan_test.go` |
| `NULL` and `''` are distinguishable, in the API and in the grid | `internal/api/service_test.go` |
| Paging visits every row exactly once — no skips, no repeats | `service_test.go` |
| Pagination off emits **no** `LIMIT`; the row cap is applied while scanning instead | `internal/driver/driver_test.go` |
| A browse with no sort chosen reads primary key descending, and reports the sort it used so `ReadCell` addresses the same row | `internal/api/service_test.go` |
| SQL Server invents an `ORDER BY` when paging unsorted (PK → first column → constant), or `OFFSET/FETCH` silently reorders between pages | `driver_test.go` |
| Every identifier is quoted per dialect; only the user's filter fragment and a new column's type/default are raw | `driver_test.go`, `ddl_test.go` |
| Non-finite floats are stringified — they cannot be JSON-encoded | `scan_test.go` |
| The long-value cap is applied by the database, not after the fetch, and only to columns that can exceed it | `internal/driver/driver_test.go`, `internal/api/service_test.go` |
| A capped cell is reported as capped — truncation is never silent | `service_test.go` |
| A batch runs as one round trip on one connection, and every result set it produces comes back — `use db; select …` must not lose the rows | `internal/api/service_test.go` |
| The full value of one cell is always reachable, on views and keyless tables too | `service_test.go` |
| Rows are written only through `ApplyChanges`, in one transaction, and a change set that does not fit the table is rejected before anything runs | `internal/api/changes_test.go` |
| Every change is applied by the table's key alone — exactly `EditKey`, original values — and must affect exactly one row, or the whole set rolls back | `changes_test.go` |
| Edited values are bound parameters, never part of the executed SQL; `Statement.Display` is for reading and is never run | `internal/driver/write_test.go` |
| A view, a keyless table, and a generated or binary column cannot be edited | `internal/driver/edit_test.go`, `changes_test.go` |
| `PreviewChanges` runs no statement from the change set, and renders what `ApplyChanges` runs | `changes_test.go` |
| An applied change set is in the activity log as a `write`, failed if it rolled back | `changes_test.go` |
| A change set spans tables of one connection and one database only, and a failure in any table rolls back every table | `changes_test.go` |
| `Statement.Short` cuts long string literals on the raw value, before quoting, so an escape is never split; `Display` and bound values stay whole | `internal/driver/write_short_test.go` |

### Design decisions

| Invariant | Why |
| --- | --- |
| The `Ctrl+F` filter is raw, uninterpreted SQL | The whole point of it. `docs/adr/0002`. It must never be fed anything that did not come from a keystroke |
| `internal/api.Service` knows nothing about Wails; both transports are pure pass-through | `docs/adr/0001`. Logic in a binding is a bug — the other binding would not have it |
| Passwords never live on the `Connection` struct; they go through `SecretStore` | `docs/adr/0007`. The default is the OS keyring |
| Nothing outside `internal/config` retains a password beyond the call that uses it. An ask-every-time password lives in the request and the dialog's state only, and appears in no log, error or activity entry | `docs/adr/0007`. `internal/api/service_test.go`, `internal/config/secrets_test.go`. The driver's pool holds it for the life of the session, which ja-db cannot prevent |
| The file fallback is never silent, and never used after the keyring has worked | `internal/config/secrets_test.go`. A UI warning cannot be dismissed |
| A connection with no SSL mode verifies TLS on every non-loopback host; skipping the check is only ever an explicit per-connection choice | `docs/adr/0008`. `internal/driver/tls_test.go` |
| `Params` cannot set a TLS key | Otherwise it sidesteps the allow-list and the warning. `tls_test.go` |
| `cmd/devserver` rejects a Host or Origin that is not this machine, whatever the port | A DNS-rebinding page would otherwise run SQL on saved connections. `cmd/devserver/main_test.go` |
| Only the CSV file export defuses formulas; the clipboard is never altered | `frontend/src/selection.test.ts`. Pasting must give the bytes in the grid |
| `cmd/devserver` binds to loopback only and refuses anything else | It serves stored credentials |
| Nothing outside `frontend/src/ui/` imports a component library | The swap-out guarantee. A leak silently voids it |
| The palette matches the object *name* first; schema and keywords only at a discount | Otherwise "user" returns everything in a schema containing those letters |
| Palette results are cut relative to the best score | Fuzzy matching is permissive by nature; ordering alone does not narrow a list |
| Activity polling is driven by the store's in-flight count, never by a bare timer | An idle app must issue no requests. A poller that runs regardless is a background load on every connected database |
| The query history is a fixed ring with capped retained SQL | It grows for the whole session otherwise, and holds statement text |
| Full SQL and error text beyond the preview live only in a 0700 per-process temp directory, at most one file per ring slot, removed on eviction, `ClearQueryHistory` and `Shutdown`; bound arguments and row values are never written | Long statements must stay readable without the log growing. The directory holds queries, so it is private and temporary. `internal/activity/registry_test.go` |
| The temp sweep never removes the directory of a live process | Two running instances share the temp directory. `TestSweepRemovesDeadAndAgedDirectoriesOnly` |
| Query timers extrapolate from the last snapshot, never from `startedAt` | `startedAt` is the server's wall clock; clock skew would show a fresh query as minutes old |
| The UI is sized in `rem` from a single root font size | The Settings slider must scale spacing and controls, not just text |
| No component names a colour literal; every one is a `var(--color-…)` token | A theme is then a block of custom properties in `index.css` and nothing else. One literal is a component that stays light in a dark theme |
| Base styles in `index.css` live inside `@layer base` | Unlayered, they sort after Tailwind's utilities at equal specificity and win every tie, so a component cannot opt out of one. That is how `focus-visible:outline-none` on the palette input was silently ignored |
| `config.ThemeIDs`, the `:root[data-theme]` blocks and `themes.ts` list the same ids | Three hand-kept copies. A theme missing from the Go list is rejected on load and the user's choice silently reverts |
| `frontend/dist/.gitkeep` stays tracked, and builds must not delete it | `main.go` embeds `frontend/dist`; without it a fresh clone will not compile |
| No component that renders the app shell subscribes to the grid selection | A click moves a one-cell highlight. If `App` re-renders, so does the unvirtualised sidebar and its menu root per table, and the click takes seconds. `useCellMenu` reads state with `getState` for exactly this reason |
| `DataGrid` is memoised and every prop it is given is stable | Its parents subscribe to state that changes constantly — `busy`, `dialog`, and `sqlText` on every keystroke. One inline arrow at a call site voids the memo silently, and the grid is the most expensive thing on screen |
| A cursor is rejected unless it matches the sort it is applied to, and its values go through `CoerceKey` | `service_test.go`. A position from another sort compares the wrong columns and returns plausible, wrong rows |
| `ReadCell` orders exactly as `ReadRows` does when it falls back to an offset | Same tiebreaker, or the offset lands on a different one of the rows that tie |
| `applyChanges` has exactly one caller, behind the review dialog | `frontend/src/invariants.test.ts`. Preview, Accept and `Ctrl+S` end at `reviewChanges`, which runs nothing. A second call site is a write the user never saw |
| Staged edits are keyed by the row's original key values, never by row index | `frontend/src/edits.test.ts`. A page turn, sort or reload moves rows; an edit must stay on the row it was made on |
| Staged edits are per table, all in one connection and database | `edits.test.ts` (`scopeClash`). The backend applies one transaction, which cannot span databases; the UI refuses the second scope instead of splitting the set |
| Every per-tab field is listed in `TAB_FIELDS` (`tabs.ts`), and anything async that writes the active-tab fields checks the tab is still active | A tab switch swaps the whole set. A field missing from the list leaks from one tab into the next; a late response that skips the check lands in a tab that never asked for it |
| The staged-changes bar is global, on the status strip | `ChangesStatus`. Edits outlive the table they were made in, so a bar over one grid would hide work in the others |
| No component calls a hook after an early return | `hooks.test.ts`. React error 300 crashed the SQL editor when a statement with no result set followed a SELECT |
| Big-editor Format and Minify touch whitespace only | `bigEdit.test.ts`. Re-stringifying would change the data |
| No app-shell component subscribes to the staged edits | Same reason as the selection rule above: `DataGrid`, `ChangesStatus`, `ReviewChangesDialog`, `LargeEditorHost` and each picker and tab-strip `TableMark` subscribe — the last with a boolean for its own table — and `App` does not |
| A context-menu item fires a store action the palette also exposes | The palette is the primary surface. A menu that calls the API directly is a second code path where the confirmation and the refresh afterwards can drift |
| Truncate and drop are decided in the store action, never at the call site | `runTruncate` / `runDrop` skip the confirmation by design; anything but a confirmation dialog calling them is a destructive statement with no prompt |
| No DDL builder emits `CASCADE` | The engine refusing is the useful answer. `CASCADE` would act on objects the user never named |
| Cancel kills a session only by an id captured on a connection the app pinned for that tracked query, and disarms it before the connection is released | `registry_test.go`, `editor.go`. A pid or thread id outlives the statement; a late kill would hit whatever the pool ran next |
| An isolation level reaches the server only as a Go constant looked up from a name in the dialect's `Capabilities.IsolationLevels` | `isolation_test.go`, `editor_test.go`. No SQL is built from the request for it; an unlisted name is refused before anything is tracked or run |
| Cancel runs the kill before cancelling the context | `registry_test.go`. MySQL's driver answers a cancelled context by closing the socket, after which the server keeps going and the kill has nothing to reach |
| `Capabilities.TruncateIsDelete` matches what `BuildTruncate` actually returns | `ddl_test.go`. The confirmation wording is derived from it, and it must not describe a statement other than the one that runs |

### Known gaps, accepted for now

- **Passwords are plaintext on disk only when no OS keyring works** (`secrets.json`, with a standing UI warning), and `Connection.Params` is always plaintext. `docs/adr/0007`. The keyring protects against other users, not malware running as the same user.
- **The filter is a SQL injection sink by construction.** Safe only while the input comes from the keyboard of whoever already holds the credentials.
- **No read-only mode.** A user can type a destructive statement into the filter or the editor and mean it. Row edits are the one write path with guards of their own (`ApplyChanges`: key-only, one row, one transaction); a connection-level read-only switch would still have to refuse those too. Enforcing otherwise belongs at the session level, not in string parsing. Truncate and drop being two clicks away in the object menu raises the stakes on this: the only guard is `confirmDestructive`, which the user can turn off.
- **No `ALTER`.** Columns can be added to a new table but not to an existing one, and nothing can be renamed or retyped. The SQL editor is the route for now — see the wishlist.
- **Wails v2 cannot cross-compile to macOS or Linux.** Windows works only because every driver is pure Go. Keep it that way — a cgo driver would end Windows cross-compilation from WSL.
