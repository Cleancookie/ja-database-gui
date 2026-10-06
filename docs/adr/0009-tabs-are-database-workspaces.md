# 9. Tabs are database workspaces

Date: 2026-10-06
Status: Accepted. Amends 0006

## Context

ADR 0006 made a tab one table. Working across several tables of one database
then meant one tab per table, and a sidebar full of tabs that said nothing
about where they pointed. The table picker sat in the main pane, so it was
gone as soon as a table opened. Going back to it meant `Ctrl+P` or a new tab.

## Decision

- **A tab is a connection and a database.** Its title is `connection /
  database`, or only the connection name for SQLite. A tab with neither is
  "New tab".
- **The sidebar expands the active tab.** While the tab has no database, it
  lists connections, then the server's databases. Once it has one, it shows a
  table search, the tab's SQL editor, `OPEN` (the tables opened in this tab)
  and `ALL` (every table and view). Functions and procedures are left out of
  `ALL`; the palette still lists them. Other tabs are one line each: colour,
  title, number of open tables, and a dot if any of them has staged edits.
- **Open tables keep their controls, not their rows.** `openTables` is tab state
  (`TAB_FIELDS`). Leaving a table writes its filter, sort and page into its
  entry. Returning restores them and fetches the rows again. `openObjectAt` is
  the one place this happens, so the sidebar, the palette, back / forward and
  `createTable` all behave the same.
- **Another database means another tab.** `openWorkspace` uses the current
  tab while it has no database. Otherwise it opens a new tab. The palette, the
  sidebar, the connection menu and the SQL editor's database picker all go
  through it.
- **The main-panel picker is removed.** An empty tab shows a short page saying
  where to go next.
- **A connection with no saved database does not guess one.** On a server with
  several databases, the user chooses. A SQLite file, a saved database or an
  explicit choice binds at once.

## Consequences

- Closing an open table with staged edits asks first and discards only that
  table's edits. Edits stay global, keyed by table.
- Dropping a table removes it from every tab's open list. Disconnecting
  blanks every tab on that connection, open list included.
- Reopening a closed tab (`Ctrl+Shift+T`) brings back its open tables and SQL
  text. SQL runs are still not kept.
- Back / forward to a table that has since been closed opens it again.
- The sidebar is always mounted, so `ObjectList` is virtualised. The sidebar
  must not subscribe to the selection, rows or staged edits
  (`frontend/src/invariants.test.ts`).
- `/` now focuses the table search, not the WHERE filter. `Ctrl+F` still
  focuses the filter.
