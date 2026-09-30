/**
 * Staged grid edits, as plain data.
 *
 * Nothing here touches the store, the DOM or the network, so the rules — what
 * counts as a change, what a delete does to an edit, what order statements go
 * in — are unit-tested without any of them. The store holds one `Staged` and
 * routes every gesture through these functions.
 *
 * Rows are keyed by the JSON of their *original* edit-key values, never by
 * their index: a page turn, a re-sort or a reload moves rows, and an edit must
 * keep pointing at the row it was made on.
 */

import type { Cell, CellInput, ChangesRequest, GridColumn, ObjectRef, RowChange } from './types'

/** JSON of a row's edit-key values, in key order. */
export type RowKey = string

/** A row as an edit sees it: its identity, and the key values that address it. */
export interface Keyed {
  key: RowKey
  /** ORIGINAL values, exactly as readRows sent them. */
  values: Record<string, Cell>
}

export interface UpdateEntry extends Keyed {
  set: Record<string, CellInput>
}

export interface InsertRow {
  id: number
  /** Columns given a value. Absent columns are left to the database. */
  set: Record<string, CellInput>
}

export interface EditSet {
  updates: Record<RowKey, UpdateEntry>
  deletes: Record<RowKey, Keyed>
  inserts: InsertRow[]
  nextInsertId: number
}

/** The current edits and the ones before them, for Ctrl+Z. */
export interface Staged {
  edits: EditSet
  past: EditSet[]
}

export const EMPTY_EDITS: EditSet = { updates: {}, deletes: {}, inserts: [], nextInsertId: 1 }
export const EMPTY_STAGED: Staged = { edits: EMPTY_EDITS, past: [] }

const HISTORY_LIMIT = 100

/** What a cell holds as text. Booleans and numbers become what a person would type. */
export function cellInputText(v: Cell): string {
  return v === null ? '' : String(v)
}

/** Column indexes of the edit key within a result, or null if one is missing. */
export function keyIndexes(resultColumns: { name: string }[], editKey: string[]): number[] | null {
  if (editKey.length === 0) return null
  const idx = editKey.map((k) => resultColumns.findIndex((c) => c.name === k))
  return idx.some((i) => i < 0) ? null : idx
}

export function keyedRow(row: Cell[], editKey: string[], idx: number[]): Keyed {
  const values: Record<string, Cell> = {}
  editKey.forEach((name, n) => {
    values[name] = row[idx[n]]
  })
  return { key: JSON.stringify(idx.map((i) => row[i])), values }
}

/** Why a cell cannot be edited, or '' when it can. */
export function blockReason(
  table: { readOnlyReason: string; editKey: string[] },
  column: Pick<GridColumn, 'editable' | 'readOnlyReason'> | undefined,
): string {
  if (table.readOnlyReason) return table.readOnlyReason
  if (table.editKey.length === 0) return 'this table has no usable key'
  if (!column) return 'this column is not part of the table'
  if (!column.editable) return column.readOnlyReason || 'this column is read-only'
  return ''
}

function sameInput(input: CellInput, original: Cell): boolean {
  if (input.kind === 'null') return original === null
  if (input.kind === 'default') return false
  return original !== null && input.value === cellInputText(original)
}

// ---- EditSet primitives: each returns its argument when nothing changed ------

/**
 * Stages one cell of an existing row. Setting a cell back to what it was drops
 * the edit, and a row whose last edit is dropped stops being an update — a
 * change set must never carry an update that changes nothing.
 */
export function setCell(
  e: EditSet,
  row: Keyed,
  column: string,
  input: CellInput,
  original: Cell,
): EditSet {
  if (e.deletes[row.key]) return e
  const entry = e.updates[row.key]
  const set = { ...entry?.set }
  if (sameInput(input, original)) {
    if (!(column in set)) return e
    delete set[column]
  } else {
    const had = set[column]
    if (had && had.kind === input.kind && had.value === input.value) return e
    set[column] = input
  }
  const updates = { ...e.updates }
  if (Object.keys(set).length === 0) delete updates[row.key]
  else updates[row.key] = { key: row.key, values: row.values, set }
  return { ...e, updates }
}

export function setInsertCell(e: EditSet, id: number, column: string, input: CellInput): EditSet {
  if (!e.inserts.some((r) => r.id === id)) return e
  return {
    ...e,
    inserts: e.inserts.map((r) => (r.id === id ? { ...r, set: { ...r.set, [column]: input } } : r)),
  }
}

/** Marks rows for deletion, or unmarks them when every one already is. */
export function toggleDelete(e: EditSet, rows: Keyed[]): EditSet {
  if (rows.length === 0) return e
  const deletes = { ...e.deletes }
  if (rows.every((r) => deletes[r.key])) for (const r of rows) delete deletes[r.key]
  else for (const r of rows) deletes[r.key] = r
  return { ...e, deletes }
}

export function addInsert(e: EditSet): EditSet {
  return {
    ...e,
    inserts: [...e.inserts, { id: e.nextInsertId, set: {} }],
    nextInsertId: e.nextInsertId + 1,
  }
}

export function removeInsert(e: EditSet, id: number): EditSet {
  if (!e.inserts.some((r) => r.id === id)) return e
  return { ...e, inserts: e.inserts.filter((r) => r.id !== id) }
}

// ---- Staged: history around an EditSet ---------------------------------------

/** Applies a change and remembers what it replaced; a no-op is not an undo step. */
export function commit(st: Staged, change: (e: EditSet) => EditSet): Staged {
  const next = change(st.edits)
  if (next === st.edits) return st
  return { edits: next, past: [...st.past, st.edits].slice(-HISTORY_LIMIT) }
}

export function undo(st: Staged): Staged {
  const prev = st.past[st.past.length - 1]
  if (!prev) return st
  return { edits: prev, past: st.past.slice(0, -1) }
}

// ---- Reading the edits -------------------------------------------------------

export interface Counts {
  updates: number
  inserts: number
  deletes: number
  total: number
}

/** A row marked for deletion is one delete, whatever was also edited in it. */
export function countOf(e: EditSet): Counts {
  const deletes = Object.keys(e.deletes).length
  const updates = Object.keys(e.updates).filter((k) => !e.deletes[k]).length
  const inserts = e.inserts.length
  return { updates, inserts, deletes, total: updates + inserts + deletes }
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

export function describeCounts(c: Counts): string {
  return `${plural(c.updates, 'update')}, ${plural(c.inserts, 'insert')}, ${plural(c.deletes, 'delete')}`
}

/**
 * The change set, in the order it is applied: deletes, updates, inserts. A
 * delete goes first so a row can be replaced by an insert that reuses its key,
 * and inserts go last so nothing else depends on a row that does not exist yet.
 */
export function toChangesRequest(
  e: EditSet,
  connectionId: string,
  ref: ObjectRef,
): ChangesRequest {
  const changes: RowChange[] = [
    ...Object.values(e.deletes).map<RowChange>((d) => ({ op: 'delete', key: d.values })),
    ...Object.values(e.updates)
      .filter((u) => !e.deletes[u.key])
      .map<RowChange>((u) => ({ op: 'update', key: u.values, set: u.set })),
    ...e.inserts.map<RowChange>((i) => ({ op: 'insert', set: i.set })),
  ]
  return { connectionId, ref, changes }
}
