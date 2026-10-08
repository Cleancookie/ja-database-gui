import { describe, expect, it } from 'vitest'
import { initialOpen, treeKey, treeRows } from './jsonTree'

const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...extra,
})

const doc = { a: { b: [1, 2] }, c: 3 }

describe('treeRows', () => {
  it('lists open containers with their children after them', () => {
    const rows = treeRows(doc, new Set(['$', '$.a']))
    expect(rows.map((r) => r.path)).toEqual(['$', '$.a', '$.a.b', '$.c'])
    expect(rows.map((r) => r.parent)).toEqual([-1, 0, 1, 0])
    expect(rows[2].segs).toEqual(['a', 'b'])
  })

  it('gives array children numeric segments', () => {
    const rows = treeRows(doc, new Set(['$', '$.a', '$.a.b']))
    expect(rows[3]).toMatchObject({ path: '$.a.b[0]', segs: ['a', 'b', 0], inArray: true })
  })
})

describe('initialOpen', () => {
  it('opens the top two levels', () => {
    expect([...initialOpen(doc)]).toEqual(['$', '$.a'])
  })

  it('leaves a huge container shut', () => {
    expect(initialOpen({ big: Array.from({ length: 101 }, () => 0) }).has('$.big')).toBe(false)
  })
})

describe('treeKey', () => {
  const rows = treeRows(doc, new Set(['$', '$.a']))

  it('moves up and down, and to either end', () => {
    expect(treeKey(key('ArrowDown'), rows, 0)).toEqual({ focus: 1 })
    expect(treeKey(key('ArrowUp'), rows, 0)).toEqual({ focus: 0 })
    expect(treeKey(key('End'), rows, 0)).toEqual({ focus: 3 })
    expect(treeKey(key('Home'), rows, 3)).toEqual({ focus: 0 })
  })

  it('opens a closed container on Right, then steps into it', () => {
    expect(treeKey(key('ArrowRight'), rows, 2)).toEqual({ open: '$.a.b' })
    expect(treeKey(key('ArrowRight'), rows, 1)).toEqual({ focus: 2 })
    expect(treeKey(key('ArrowRight'), rows, 3)).toBeNull()
  })

  it('closes an open container on Left, else steps out to the parent', () => {
    expect(treeKey(key('ArrowLeft'), rows, 1)).toEqual({ close: '$.a' })
    expect(treeKey(key('ArrowLeft'), rows, 3)).toEqual({ focus: 0 })
    expect(treeKey(key('ArrowLeft'), treeRows(doc, new Set()), 0)).toBeNull()
  })

  it('ignores modified arrows, which belong to someone else', () => {
    expect(treeKey(key('ArrowLeft', { shiftKey: true }), rows, 1)).toBeNull()
  })
})
