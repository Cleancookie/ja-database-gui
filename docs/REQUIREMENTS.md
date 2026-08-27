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
ring of 200 entries, `Clear log`, and a confirmation on Cancel that honours the
existing "confirm destructive actions" setting.

Catalogue reads are shown while they run but are not retained in the history:
they fire on every table open and would push the user's own queries out of the
ring within a minute.

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
| Cause of the lag | `useCellMenu` subscribed to the *selection*. It is held by `App` and by `SqlEditor`, so every cell click re-rendered the whole shell — sidebar included, and the sidebar's object list is unvirtualised with one Radix menu root per table. Moving a one-cell highlight was doing a few hundred menu roots' worth of work |
| Fix | The hook reads the store with `getState` and returns a builder that is stable for the life of the component. Correct because the builder only ever runs while the menu is rendering, so `getState` is already current state |
| Second fix | `Sidebar` is `memo`'d. It takes no props and is the most expensive thing on screen, so no parent re-render should ever cost anything |
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

### Design decisions

| Invariant | Why |
| --- | --- |
| The `Ctrl+F` filter is raw, uninterpreted SQL | The whole point of it. `docs/adr/0002`. It must never be fed anything that did not come from a keystroke |
| `internal/api.Service` knows nothing about Wails; both transports are pure pass-through | `docs/adr/0001`. Logic in a binding is a bug — the other binding would not have it |
| Passwords never live on the `Connection` struct; they go through `SecretStore` | `docs/adr/0003`. That seam is what makes the keyring migration cheap |
| `cmd/devserver` binds to loopback only and refuses anything else | It serves stored credentials |
| Nothing outside `frontend/src/ui/` imports a component library | The swap-out guarantee. A leak silently voids it |
| The palette matches the object *name* first; schema and keywords only at a discount | Otherwise "user" returns everything in a schema containing those letters |
| Palette results are cut relative to the best score | Fuzzy matching is permissive by nature; ordering alone does not narrow a list |
| Activity polling is driven by the store's in-flight count, never by a bare timer | An idle app must issue no requests. A poller that runs regardless is a background load on every connected database |
| The query history is a fixed ring with capped retained SQL | It grows for the whole session otherwise, and holds statement text |
| Query timers extrapolate from the last snapshot, never from `startedAt` | `startedAt` is the server's wall clock; clock skew would show a fresh query as minutes old |
| The UI is sized in `rem` from a single root font size | The Settings slider must scale spacing and controls, not just text |
| No component names a colour literal; every one is a `var(--color-…)` token | A theme is then a block of custom properties in `index.css` and nothing else. One literal is a component that stays light in a dark theme |
| Base styles in `index.css` live inside `@layer base` | Unlayered, they sort after Tailwind's utilities at equal specificity and win every tie, so a component cannot opt out of one. That is how `focus-visible:outline-none` on the palette input was silently ignored |
| `config.ThemeIDs`, the `:root[data-theme]` blocks and `themes.ts` list the same ids | Three hand-kept copies. A theme missing from the Go list is rejected on load and the user's choice silently reverts |
| `frontend/dist/.gitkeep` stays tracked, and builds must not delete it | `main.go` embeds `frontend/dist`; without it a fresh clone will not compile |
| No component that renders the app shell subscribes to the grid selection | A click moves a one-cell highlight. If `App` re-renders, so does the unvirtualised sidebar and its menu root per table, and the click takes seconds. `useCellMenu` reads state with `getState` for exactly this reason |
| `DataGrid` is memoised and every prop it is given is stable | Its parents subscribe to state that changes constantly — `busy`, `dialog`, and `sqlText` on every keystroke. One inline arrow at a call site voids the memo silently, and the grid is the most expensive thing on screen |
| A context-menu item fires a store action the palette also exposes | The palette is the primary surface. A menu that calls the API directly is a second code path where the confirmation and the refresh afterwards can drift |
| Truncate and drop are decided in the store action, never at the call site | `runTruncate` / `runDrop` skip the confirmation by design; anything but a confirmation dialog calling them is a destructive statement with no prompt |
| No DDL builder emits `CASCADE` | The engine refusing is the useful answer. `CASCADE` would act on objects the user never named |
| `Capabilities.TruncateIsDelete` matches what `BuildTruncate` actually returns | `ddl_test.go`. The confirmation wording is derived from it, and it must not describe a statement other than the one that runs |

### Known gaps, accepted for now

- **Passwords are plaintext on disk.** `docs/adr/0003`. Must not ship to anyone else's machine as-is.
- **The filter is a SQL injection sink by construction.** Safe only while the input comes from the keyboard of whoever already holds the credentials.
- **No read-only mode.** A user can type a destructive statement into the filter or the editor and mean it. Enforcing otherwise belongs at the session level, not in string parsing. Truncate and drop being two clicks away in the object menu raises the stakes on this: the only guard is `confirmDestructive`, which the user can turn off.
- **No `ALTER`.** Columns can be added to a new table but not to an existing one, and nothing can be renamed or retyped. The SQL editor is the route for now — see the wishlist.
- **Wails v2 cannot cross-compile to macOS or Linux.** Windows works only because every driver is pure Go. Keep it that way — a cgo driver would end Windows cross-compilation from WSL.
