import { describe, expect, it, vi } from 'vitest'
import { columnJump, filterColumns, onRevealColumn, revealColumn } from './rowPane'

const NAMES = ['id', 'customer_id', 'created_at', 'updated_at', 'email', 'status']

describe('filterColumns', () => {
  it('keeps every column in result order for an empty or blank query', () => {
    expect(filterColumns('', NAMES).map((h) => h.index)).toEqual([0, 1, 2, 3, 4, 5])
    expect(filterColumns('  ', NAMES).every((h) => h.positions.length === 0)).toBe(true)
  })

  it('ranks the closest name first', () => {
    expect(filterColumns('email', NAMES)[0].index).toBe(4)
    expect(filterColumns('upd', NAMES)[0].index).toBe(3)
  })

  it('drops names that do not match at all', () => {
    expect(filterColumns('zzz', NAMES)).toEqual([])
  })

  it('returns highlight positions into the name', () => {
    const [hit] = filterColumns('cat', NAMES)
    expect(NAMES[hit.index]).toBe('created_at')
    expect(hit.positions.map((p) => NAMES[hit.index][p]).join('')).toBe('cat')
  })
})

describe('columnJump', () => {
  it('selects the cell in the cursor row', () => {
    expect(columnJump(3, 7, 10)).toEqual({ kind: 'select', row: 3, col: 7 })
  })

  it('only reveals the column with no row, or a row no longer there', () => {
    expect(columnJump(null, 2, 10)).toEqual({ kind: 'reveal', col: 2 })
    expect(columnJump(10, 2, 10)).toEqual({ kind: 'reveal', col: 2 })
  })
})

describe('revealColumn', () => {
  it('reaches only the grids of that source, until they unsubscribe', () => {
    const browse = vi.fn()
    const sql = vi.fn()
    const off = onRevealColumn('browse', browse)
    onRevealColumn('sql', sql)()
    revealColumn('browse', 4)
    expect(browse).toHaveBeenCalledWith(4)
    expect(sql).not.toHaveBeenCalled()
    off()
    revealColumn('browse', 5)
    expect(browse).toHaveBeenCalledTimes(1)
  })
})
