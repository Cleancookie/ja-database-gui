import { describe, expect, it } from 'vitest'
import {
  EMPTY_EDITS,
  EMPTY_STAGED,
  addInsert,
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
  toChangesRequest,
  toggleDelete,
  undo,
  type Keyed,
} from './edits'

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

describe('history', () => {
  it('undoes one step at a time, and a no-op is not a step', () => {
    let st = commit(EMPTY_STAGED, (e) => setCell(e, row1, 'a', val('x'), 'o'))
    st = commit(st, (e) => setCell(e, row1, 'b', val('y'), 'o'))
    expect(commit(st, (e) => setCell(e, row1, 'b', val('y'), 'o'))).toBe(st)
    st = undo(st)
    expect(Object.keys(st.edits.updates['[1]'].set)).toEqual(['a'])
    st = undo(st)
    expect(countOf(st.edits).total).toBe(0)
    expect(undo(st)).toBe(st)
  })

  it('is bounded', () => {
    let st = EMPTY_STAGED
    for (let i = 0; i < 150; i++) st = commit(st, (e) => addInsert(e))
    expect(st.past.length).toBe(100)
  })
})

describe('toChangesRequest', () => {
  it('sends original key values and only the changed columns', () => {
    let e = setCell(EMPTY_EDITS, { key: '[7]', values: { id: 7 } }, 'id', val('70'), 7)
    e = setCell(e, { key: '[7]', values: { id: 7 } }, 'name', NULL, 'x')
    const req = toChangesRequest(e, 'c1', ref)
    expect(req).toEqual({
      connectionId: 'c1',
      ref,
      changes: [{ op: 'update', key: { id: 7 }, set: { id: val('70'), name: NULL } }],
    })
  })

  it('orders deletes, then updates, then inserts', () => {
    let e = addInsert(EMPTY_EDITS)
    e = setCell(e, row1, 'a', val('x'), 'o')
    e = toggleDelete(e, [row2])
    const ops = toChangesRequest(e, 'c', ref).changes.map((c) => c.op)
    expect(ops).toEqual(['delete', 'update', 'insert'])
  })

  it('leaves out the edits of a row that is being deleted', () => {
    let e = setCell(EMPTY_EDITS, row1, 'a', val('x'), 'o')
    e = toggleDelete(e, [row1])
    expect(toChangesRequest(e, 'c', ref).changes).toEqual([{ op: 'delete', key: { id: 1 } }])
  })

  it('gives an insert no key, and only the columns that were filled in', () => {
    let e = addInsert(EMPTY_EDITS)
    e = setInsertCell(e, 1, 'name', val('n'))
    expect(toChangesRequest(e, 'c', ref).changes).toEqual([
      { op: 'insert', set: { name: val('n') } },
    ])
  })

  it('has one change per counted change', () => {
    let e = addInsert(addInsert(EMPTY_EDITS))
    e = setCell(e, row1, 'a', val('x'), 'o')
    e = toggleDelete(e, [row2])
    expect(toChangesRequest(e, 'c', ref).changes).toHaveLength(countOf(e).total)
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
