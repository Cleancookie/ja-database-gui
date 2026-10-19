# 11. A tab is one table

Date: 2026-10-19
Status: Accepted. Supersedes 0009, amends 0006

## Context

ADR 0009 made a tab a database workspace holding a list of open tables. That
gave two levels of switching: tabs, and the open tables inside each one, each
with its own keys (`Ctrl+Tab`, `Alt+PageUp`), its own close (`Ctrl+W`,
`Alt+W`) and its own list in the sidebar. Once 0009's amendment split the
sidebar into `TABS` and `TABLES`, the open list sat between the two and
belonged to neither. Users expected a browser: one thing open per tab.

## Decision

- **A tab shows one table, or the SQL editor.** `openTables` is gone. The
  table on screen (`activeRef`) and its filter, sort and page are already tab
  state (`TAB_FIELDS`), so switching tabs is what keeps and restores them.
- **Opening a table goes to its tab.** `openObject` is the one entry point:
  the sidebar, the palette, the object menu, `createTable` and
  `goToChangedTable` all call it. A table already open in a tab on this
  connection switches to that tab. Else a bound tab with nothing open is used.
  Else a new tab opens on the same connection and database.
- **`TABLES` browses the active tab's database.** Its header names the
  connection and has the database picker. Choosing another database opens a
  tab on it (`openWorkspace`).
- **The SQL editor is a tab kind.** `Ctrl+E` turns an empty tab into an editor,
  else opens an editor tab on the same database. On an editor tab it does
  nothing. Choosing a database in the editor opens an editor tab on it.
- **Details is a view of a table's tab.** `openDetails` opens the table first.
  The activity page is unchanged.
- **A tab row reads table, then place.** "users  Prod / shop", "SQL  Prod /
  shop", or "New tab". A dot marks staged edits on the tab's table.

## Consequences

- `Alt+W` and `Alt+PageUp` / `Alt+PageDown` are removed. `Ctrl+W` closes the
  tab. With staged edits on its table, and no other tab showing that table, it
  asks first and discards only that table's edits.
- Back / forward skips empty pages. A tab is empty only on its way to a table,
  and going back there would take the table out of it.
- Dropping a table blanks every tab showing it. Disconnecting blanks every tab
  on that connection.
- Reopening a closed tab brings back its table and SQL text. SQL runs are not
  kept.
- The sidebar still must not subscribe to the selection, rows or staged edits
  (`frontend/src/invariants.test.ts`).
