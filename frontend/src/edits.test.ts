import { describe, expect, it } from 'vitest'
import {
  EMPTY_EDITS,
  EMPTY_STAGED,
  addInsert,
  addJsonEdit,
  blockReason,
  cellInputText,
  commit,
  countOf,
  describeCounts,
  keyIndexes,
  keyedRow,
  removeInsert,
  setCell,
  setInsertCell,
  stagedText,
  editsFor,
  removeTable,
  scopeClash,
  tableKey,
  toChangesRequest,
  totalOf,
  type EditSet,
  toggleDelete,
  undo,
  type Keyed,
} from './edits'
import type { JSONEdit } from './types'

const ref = { database: 'd', schema: '', name: 't' }
const row1: Keyed = { key: '[1]', values: { id: 1 } }
const row2: Keyed = { key: '[2]', values: { id: 2 } }
const val = (value: string) => ({ kind: 'value' as const, value })
const NULL = { kind: 'null' as const }

describe('keyedRow', () => {
  it('addresses a row by its original key values, in key order', () => {
    const idx = keyIndexes([{ name: 'name' }, { name: 'b' }, { name: 'a' }], ['a', 'b'])!
    expect(keyedRow(['x', 'B', 'A'], ['a', 'b'], idx)).toEqual({
      key: '["A","B"]',
      values: { a: 'A', b: 'B' },
    })
  })

  it('keeps a bigint string apart from a number', () => {
    const idx = [0]
    expect(keyedRow(['9007199254740993'], ['id'], idx).key).toBe('["9007199254740993"]')
    expect(keyedRow([1], ['id'], idx).key).not.toBe(keyedRow(['1'], ['id'], idx).key)
  })

  it('is null when the key is empty or a key column is missing from the result', () => {
    expect(keyIndexes([{ name: 'a' }], [])).toBeNull()
    expect(keyIndexes([{ name: 'a' }], ['id'])).toBeNull()
  })
})

describe('setCell', () => {
  it('stages a changed value as an update of that row', () => {
    const e = setCell(EMPTY_EDITS, row1, 'name', val('bob'), 'alice')
    expect(e.updates['[1]'].set).toEqual({ name: val('bob') })
    expect(e.updates['[1]'].values).toEqual({ id: 1 })
  })

  it('drops the edit when the value goes back to the original', () => {
    const e1 = setCell(EMPTY_EDITS, row1, 'name', val('bob'), 'alice')
    const e2 = setCell(e1, row1, 'name', val('alice'), 'alice')
    expect(e2.updates).toEqual({})
    expect(countOf(e2).total).toBe(0)
  })

  it('keeps the row as an update while another cell in it is still edited', () => {
    let e = setCell(EMPTY_EDITS, row1, 'a', val('x'), 'o')
    e = setCell(e, row1, 'b', val('y'), 'o')
    e = setCell(e, row1, 'a', val('o'), 'o')
    expect(Object.keys(e.updates['[1]'].set)).toEqual(['b'])
  })

  it('treats a number typed as its own text as unchanged', () => {
    expect(setCell(EMPTY_EDITS, row1, 'n', val('5'), 5)).toBe(EMPTY_EDITS)
  })

  it('tells NULL from the empty string, both ways', () => {
    expect(setCell(EMPTY_EDITS, row1, 'c', val(''), null).updates['[1]'].set.c).toEqual(val(''))
    expect(setCell(EMPTY_EDITS, row1, 'c', NULL, '').updates['[1]'].set.c).toEqual(NULL)
    expect(setCell(EMPTY_EDITS, row1, 'c', NULL, null)).toBe(EMPTY_EDITS)
    expect(setCell(EMPTY_EDITS, row1, 'c', val(''), '')).toBe(EMPTY_EDITS)
  })

  it('never drops a set-to-default as unchanged', () => {
    const e = setCell(EMPTY_EDITS, row1, 'c', { kind: 'default' }, null)
    expect(e.updates['[1]'].set.c).toEqual({ kind: 'default' })
  })

  it('ignores an edit to a row that is staged for deletion', () => {
    const del = toggleDelete(EMPTY_EDITS, [row1])
    expect(setCell(del, row1, 'c', val('x'), 'o')).toBe(del)
  })

  it('does not mutate the set it was given', () => {
    const before = setCell(EMPTY_EDITS, row1, 'a', val('x'), 'o')
    const snapshot = JSON.stringify(before)
    setCell(before, row1, 'a', val('z'), 'o')
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe('deletes', () => {
  it('stages every row given, and toggles them back only when all are staged', () => {
    const one = toggleDelete(EMPTY_EDITS, [row1])
    const both = toggleDelete(one, [row1, row2])
    expect(Object.keys(both.deletes)).toEqual(['[1]', '[2]'])
    expect(Object.keys(toggleDelete(both, [row1, row2]).deletes)).toEqual([])
  })

  it('counts a deleted row once, even with edits in it', () => {
    let e = setCell(EMPTY_EDITS, row1, 'a', val('x'), 'o')
    e = toggleDelete(e, [row1])
    expect(countOf(e)).toEqual({ updates: 0, inserts: 0, deletes: 1, total: 1 })
  })

  it('brings the edits back when the delete is withdrawn', () => {
    let e = setCell(EMPTY_EDITS, row1, 'a', val('x'), 'o')
    e = toggleDelete(toggleDelete(e, [row1]), [row1])
    expect(countOf(e)).toMatchObject({ updates: 1, deletes: 0 })
  })
})

describe('inserts', () => {
  it('numbers rows by id, not position, so removing one leaves the others addressable', () => {
    let e = addInsert(addInsert(EMPTY_EDITS))
    e = setInsertCell(e, 2, 'a', val('second'))
    e = removeInsert(e, 1)
    expect(e.inserts).toEqual([{ id: 2, set: { a: val('second') } }])
  })

  it('ignores a cell for an insert row that is gone', () => {
    expect(setInsertCell(EMPTY_EDITS, 9, 'a', val('x'))).toBe(EMPTY_EDITS)
  })
})

const scope = { connectionId: 'c1', database: 'd' }
const tref = (name: string) => ({ database: 'd', schema: '', name })
const orders = tref('orders')
const people = tref('people')

describe('history', () => {
  it('undoes one step at a time, and a no-op is not a step', () => {
    let st = commit(EMPTY_STAGED, scope, ref, (e) => setCell(e, row1, 'a', val('x'), 'o'))
    st = commit(st, scope, ref, (e) => setCell(e, row1, 'b', val('y'), 'o'))
    expect(commit(st, scope, ref, (e) => setCell(e, row1, 'b', val('y'), 'o'))).toBe(st)
    st = undo(st)
    expect(Object.keys(editsFor(st, tableKey('c1', ref)).updates['[1]'].set)).toEqual(['a'])
    st = undo(st)
    expect(totalOf(st).total).toBe(0)
    expect(st.scope).toBeNull()
    expect(undo(st)).toBe(st)
  })

  it('is bounded', () => {
    let st = EMPTY_STAGED
    for (let i = 0; i < 150; i++) st = commit(st, scope, ref, (e) => addInsert(e))
    expect(st.past.length).toBe(100)
  })
})

describe('several tables', () => {
  const two = () => {
    let st = commit(EMPTY_STAGED, scope, orders, (e) => setCell(e, row1, 'a', val('x'), 'o'))
    st = commit(st, scope, people, (e) => toggleDelete(e, [row2]))
    return st
  }

  it('keeps each table apart and in the order they were first edited', () => {
    let st = two()
    st = commit(st, scope, orders, (e) => setCell(e, row2, 'a', val('z'), 'o'))
    expect(st.order.map((k) => st.tables[k].ref.name)).toEqual(['orders', 'people'])
    expect(totalOf(st)).toEqual({ updates: 2, inserts: 0, deletes: 1, total: 3, tables: 2 })
  })

  it('does not confuse two tables that share a row key', () => {
    const st = two()
    expect(countOf(editsFor(st, tableKey('c1', orders)))).toMatchObject({ updates: 1, deletes: 0 })
    expect(countOf(editsFor(st, tableKey('c1', people)))).toMatchObject({ updates: 0, deletes: 1 })
  })

  it('drops a table from the set when its last change is withdrawn', () => {
    let st = two()
    st = commit(st, scope, people, (e) => toggleDelete(e, [row2]))
    expect(st.order.map((k) => st.tables[k].ref.name)).toEqual(['orders'])
    st = commit(st, scope, orders, (e) => setCell(e, row1, 'a', val('o'), 'o'))
    expect(st.scope).toBeNull()
  })

  it('refuses a second connection or database and leaves the set as it was', () => {
    const st = two()
    const other = { connectionId: 'c2', database: 'd' }
    expect(scopeClash(st, other)).toEqual(scope)
    expect(scopeClash(st, { connectionId: 'c1', database: 'other' })).toEqual(scope)
    expect(scopeClash(st, scope)).toBeNull()
    expect(commit(st, other, orders, (e) => addInsert(e))).toBe(st)
    expect(scopeClash(EMPTY_STAGED, other)).toBeNull()
  })

  it('removes one table without touching the rest or the history', () => {
    const st = two()
    const gone = removeTable(st, tableKey('c1', orders))
    expect(gone.order).toHaveLength(1)
    expect(gone.scope).toEqual(scope)
    expect(removeTable(gone, tableKey('c1', people)).scope).toBeNull()
    expect(gone.past).toBe(st.past)
  })

  it('undoes across tables', () => {
    const st = undo(two())
    expect(st.order).toHaveLength(1)
  })

  it('builds one flat change list, tables in edit order, each change carrying its table', () => {
    const st = commit(two(), scope, orders, (e) => addInsert(e))
    const req = toChangesRequest(st)!
    expect(req.connectionId).toBe('c1')
    expect(req.changes.map((c) => `${c.ref.name}:${c.op}`)).toEqual([
      'orders:update',
      'orders:insert',
      'people:delete',
    ])
  })
})

describe('toChangesRequest', () => {
  const stage = (f: (e: EditSet) => EditSet) => commit(EMPTY_STAGED, scope, ref, f)

  it('is null with nothing staged', () => {
    expect(toChangesRequest(EMPTY_STAGED)).toBeNull()
  })

  it('sends original key values and only the changed columns', () => {
    const st = stage((e) => {
      e = setCell(e, { key: '[7]', values: { id: 7 } }, 'id', val('70'), 7)
      return setCell(e, { key: '[7]', values: { id: 7 } }, 'name', NULL, 'x')
    })
    expect(toChangesRequest(st)).toEqual({
      connectionId: 'c1',
      changes: [{ ref, op: 'update', key: { id: 7 }, set: { id: val('70'), name: NULL } }],
    })
  })

  it('orders deletes, then updates, then inserts', () => {
    const st = stage((e) => toggleDelete(setCell(addInsert(e), row1, 'a', val('x'), 'o'), [row2]))
    expect(toChangesRequest(st)!.changes.map((c) => c.op)).toEqual(['delete', 'update', 'insert'])
  })

  it('leaves out the edits of a row that is being deleted', () => {
    const st = stage((e) => toggleDelete(setCell(e, row1, 'a', val('x'), 'o'), [row1]))
    expect(toChangesRequest(st)!.changes).toEqual([{ ref, op: 'delete', key: { id: 1 } }])
  })

  it('gives an insert no key, and only the columns that were filled in', () => {
    const st = stage((e) => setInsertCell(addInsert(e), 1, 'name', val('n')))
    expect(toChangesRequest(st)!.changes).toEqual([{ ref, op: 'insert', set: { name: val('n') } }])
  })

  it('has one change per counted change', () => {
    const st = stage((e) =>
      toggleDelete(setCell(addInsert(addInsert(e)), row1, 'a', val('x'), 'o'), [row2]),
    )
    expect(toChangesRequest(st)!.changes).toHaveLength(totalOf(st).total)
  })
})

describe('describing', () => {
  it('pluralises, and always says all three', () => {
    expect(describeCounts({ updates: 3, inserts: 1, deletes: 0, total: 4 })).toBe(
      '3 updates, 1 insert, 0 deletes',
    )
  })

  it('reads a cell as the text a person would type', () => {
    expect(cellInputText(null)).toBe('')
    expect(cellInputText(12)).toBe('12')
    expect(cellInputText(true)).toBe('true')
  })
})

describe('blockReason', () => {
  const ok = { readOnlyReason: '', editKey: ['id'] }
  it('is empty for an editable cell', () => {
    expect(blockReason(ok, { editable: true })).toBe('')
  })
  it('names why a table is read-only before anything about the column', () => {
    expect(blockReason({ readOnlyReason: 'it is a view', editKey: [] }, { editable: true })).toBe(
      'it is a view',
    )
  })
  it('does not trust an empty key', () => {
    expect(blockReason({ readOnlyReason: '', editKey: [] }, { editable: true })).not.toBe('')
  })
  it('uses the column reason, with a fallback', () => {
    expect(blockReason(ok, { editable: false, readOnlyReason: 'generated' })).toBe('generated')
    expect(blockReason(ok, { editable: false })).toBe('this column is read-only')
  })
})

describe('JSON path edits', () => {
  const rename: JSONEdit = { op: 'rename', path: ['a'], newKey: 'b' }
  const drop: JSONEdit = { op: 'remove', path: ['b'] }

  it('start a json input on a cell with nothing staged', () => {
    expect(addJsonEdit(undefined, rename)).toEqual({
      ok: true,
      input: { kind: 'json', edits: [rename] },
    })
  })

  it('pile up on a cell that already has path edits', () => {
    const first = addJsonEdit(undefined, rename)
    if (!first.ok) throw new Error(first.reason)
    expect(addJsonEdit(first.input, drop)).toEqual({
      ok: true,
      input: { kind: 'json', edits: [rename, drop] },
    })
  })

  it('apply to the text of a staged whole value and keep it whole', () => {
    expect(addJsonEdit(val('{"a": 1}'), rename)).toEqual({
      ok: true,
      input: { kind: 'value', value: '{"b": 1}' },
    })
    expect(addJsonEdit(val('{"x": 1}'), rename).ok).toBe(false)
  })

  it('are refused on a cell staged as NULL, and on the root', () => {
    expect(addJsonEdit(NULL, rename)).toMatchObject({ ok: false, reason: /NULL/ })
    expect(addJsonEdit(undefined, { op: 'set', path: [], value: '1' }).ok).toBe(false)
  })

  it('show through as the staged text, falling back to the loaded value', () => {
    const input = { kind: 'json' as const, edits: [rename] }
    expect(stagedText(input, '{"a":1}')).toBe('{"b":1}')
    expect(stagedText(input, '{"a":1')).toBe('{"a":1')
    expect(stagedText(val('x'), 'y')).toBe('x')
    expect(stagedText(NULL, 'y')).toBe('')
  })

  it('stage as a change that a later whole value replaces', () => {
    const json = { kind: 'json' as const, edits: [rename] }
    let e = setCell(EMPTY_EDITS, row1, 'doc', json, '{"a":1}')
    expect(e.updates[row1.key].set.doc).toBe(json)
    // A second, different list of edits is a change even with no value text.
    const more = { kind: 'json' as const, edits: [rename, drop] }
    e = setCell(e, row1, 'doc', more, '{"a":1}')
    expect(e.updates[row1.key].set.doc).toBe(more)
    // The large editor's whole value replaces the path edits outright.
    e = setCell(e, row1, 'doc', val('{"c":1}'), '{"a":1}')
    expect(e.updates[row1.key].set.doc).toEqual(val('{"c":1}'))
    // And setting it back to what was loaded drops the edit, as for any cell.
    expect(setCell(e, row1, 'doc', val('{"a":1}'), '{"a":1}').updates).toEqual({})
  })
})
