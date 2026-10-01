# 6. Tabs replace the sidebar

Date: 2026-10-01
Status: Accepted

## Context

The app had a left sidebar (connections, databases, tables) and one main pane.
Use showed a lopsided pattern: the first half-minute is spent in the sidebar
choosing where to go, and nearly all the rest in the main pane, almost never
returning to the sidebar. Meanwhile the app deliberately had no tabs — a recent
list in the palette stood in for them — so comparing two tables meant
re-opening one each time, losing its filter, sort, page and selection.

## Decision

- **The left rail is a vertical tab strip.** Each tab is a workspace: a table
  (or view), its filter, sort, page and selection, plus that tab's own SQL
  editor and details page, which are views inside the tab. A tab may be on a
  different connection or database from its neighbours.
- **A tab with nothing open is the picker.** Connections, databases and tables
  are three columns in the main pane, filling left to right. It is what a new
  tab shows, and what the app starts on.
- **`Ctrl+P` retargets the current tab.** `Ctrl+T` opens a new picker tab,
  `Ctrl+W` closes, `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle, `Ctrl+B` shows or hides
  the strip.
- **The main panel is routed.** What it shows is a page — picker, table, SQL
  editor, details, activity — and every change of page, including switching
  tab, is recorded in one list. The mouse back/forward buttons walk that list
  across tabs; with Shift they cycle tabs. Pages are recorded by a store
  subscription on `pageOf`, not at call sites.
- **Tabs are not persisted.** The app starts on the picker, as it did.
- **State stays flat.** The store's "active table / connection / SQL" fields
  remain the live state of the active tab, and every other tab holds a saved
  copy. Switching swaps the sets (`frontend/src/tabs.ts`), so no component
  reads from a tab object.

## Consequences

- Staged edits stay global, not per tab. They already span tables and are
  keyed by connection, database and table, so two tabs on one table share
  pending edits rather than diverging.
- A response meant for a tab the user has since left is dropped: row fetches
  by the existing sequence counter, connect / database / details by a tab
  check. A tab left mid-load reloads when returned to.
- Disconnecting or dropping a table blanks every tab showing it.
- The app shell must not subscribe to the grid selection or staged edits
  (`docs/REQUIREMENTS.md`); the strip reads only tab titles and a per-table
  dirty flag.
- Supersedes the "No tabs, so the palette remembers" section of
  `ARCHITECTURE.md`. The recent list stays: it still orders the palette.
