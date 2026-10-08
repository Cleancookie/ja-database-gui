# 5. Row edits are staged, key-addressed, and applied in one transaction

Date: 2026-09-30
Status: Accepted

## Context

The grid was read-only. Editing it means writing to a database the user cares
about, from a surface where a slip is one keystroke: a cell typed into, a row
deleted, a table with no key.

The SQL editor already writes, but it is the user's own statement, reviewed by
them before they run it. A grid edit is the reverse — a statement the app
assembles from a gesture — so the app has to be the one that refuses to guess.

## Decision

- **Edits are staged.** The grid accumulates `RowChange`s (update, insert,
  delete) and sends them together. `PreviewChanges` returns the SQL with the
  values written in, runs nothing, and is what the user reviews. `ApplyChanges`
  runs it. Both build statements through `planChanges` → `Driver.BuildChange`, so
  the preview cannot drift from what runs.
- **A row is addressed by its key, and only by its key.** `ReadRows` reports
  `EditKey`: the primary key, else the first unique index that is complete (no
  expression, no WHERE) with every column NOT NULL. A change must send exactly
  those columns, with their *original* values. A table with no such key is
  read-only, as are views.
- **Exactly one row.** Every update, delete and insert must report one row
  affected. Zero means the row changed or went away since it was loaded — the
  edit is stale. More than one means the key was not unique after all. Both stop
  the apply.
- **One transaction.** Any failure or wrong count rolls the whole change set
  back and comes back as a `Conflict{index, message}`. Nothing is half-saved.
- **Values are bound.** Never concatenated into the executed SQL. They are
  coerced by the column's declared type, in one place (`driver.CoerceValue`).
  `null` and `default` are kinds of their own so NULL is never the empty string.
- **Columns that cannot round-trip are read-only**: generated, binary (the grid
  holds a hex preview, and saving it would overwrite the bytes with its text),
  and on SQL Server identity and rowversion.
- Writes go through the same `query.Runner` as everything else, as kind `write`.

## Consequences

- A stale grid cannot silently overwrite someone else's change, and a bad key
  cannot fan out across rows. The price is that a change can be refused when a
  looser statement would have worked.
- Keyless tables cannot be edited from the grid. The SQL editor remains the
  route; making up a key (rowid, ctid) was rejected because it is not stable
  across the dialects or across a reload.
- The edit metadata costs three catalogue reads the first time a table is
  opened, cached beside the column list.
- Display text is a convenience, not a contract: it is rendered per dialect but
  never parsed or run, so a quirk in its quoting cannot change what is written.
- Only SQLite has run the apply path end to end. On SQL Server a trigger that
  touches other rows may inflate the rows-affected count and get a good change
  refused as a conflict; that is unverified against a live server.

## Amendment 2026-09-30: one change set, several tables

- **A change set may span tables.** `ref` moved from `ChangesRequest` onto each
  `RowChange`. All changes share the request's connection and **one database**:
  a transaction cannot cross databases, so a change naming another is refused
  before anything runs.
- **Still one transaction.** Statements run in the order given across all
  tables; the one-row rule and the rollback are unchanged. `Conflict.Index` is
  into the flat `changes` list; `Conflict.Table` names the table for messages.
- **Validation is per table.** Each change is checked against its own table's
  key, columns and read-only facts, read once per table per call.
- **Activity log.** Still one `write` entry per transaction; its text starts
  with `-- N changes across M tables`.
- **Short display.** `Statement.Short` is `Display` with every string literal
  over 160 characters cut to its first 160 and ended `…(+N more chars)` inside
  the quotes, so a review of an UPDATE setting a 200 KB value can be read.
  It comes from the same template as `Display`; the cut is made on the raw value
  before the dialect quotes it, so it cannot split an escape. `Display` and the
  bound value stay whole. `Statement.Cells` gives each set column's kind and
  character count.

## Amendment 2026-10-08: path edits inside a JSON value

- **A fourth cell kind, `json`.** `CellValue.edits` lists `set`, `remove`,
  `rename` and `append` ops, each with a path from the root. They are applied in
  order and render as nested dialect functions over the column's current value
  (`json_set`, `JSON_SET`, `jsonb_set`, `JSON_MODIFY`). A 1 MB value is never
  sent back to change one key.
- **Merge-friendly by construction.** Only the touched paths are written, so a
  concurrent change to another key of the same value survives.
- **Update only.** The kind is refused on insert and delete. It is allowed on
  json and text-like columns: the user chose path SQL even for text holding JSON,
  accepting that postgres renormalises such text through `jsonb`.
- **Paths and values are bound.** Keys come from data, so they are never
  spliced into the SQL. The dialect quirks live in each dialect's file behind an
  optional `jsonEditor`, and `Driver` is unchanged.
- **Known limits.** A rename re-reads the value before it, so each rename in one
  cell doubles the statement. A renamed key moves to the end of its object. SQL
  Server cannot remove an array element by path, so that one op is refused and
  the UI points to editing the whole value.
- **The client splices text.** A staged JSON edit shows in the grid and the tree
  through `applyJsonEdits`. It replaces only the edited node's text, so big
  numbers and key order elsewhere stay byte-identical. A cell already staged as a
  whole value takes tree edits as text and stays a whole value.
