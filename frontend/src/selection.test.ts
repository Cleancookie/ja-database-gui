import { describe, expect, it } from 'vitest'
import {
  csv,
  csvField,
  describeCopy,
  inList,
  inRect,
  rectOf,
  rectSize,
  selectionText,
  sqlLiteral,
} from './selection'

describe('rectOf', () => {
  it('orders the corners however the range was dragged', () => {
    const up = rectOf({ anchor: { row: 7, col: 4 }, focus: { row: 2, col: 1 } })
    expect(up).toEqual({ top: 2, bottom: 7, left: 1, right: 4 })
    const down = rectOf({ anchor: { row: 2, col: 1 }, focus: { row: 7, col: 4 } })
    expect(down).toEqual(up)
  })

  it('is a single cell when the anchor is the focus', () => {
    const r = rectOf({ anchor: { row: 3, col: 3 }, focus: { row: 3, col: 3 } })
    expect(rectSize(r)).toEqual({ rows: 1, cols: 1, cells: 1 })
    expect(inRect(r, 3, 3)).toBe(true)
    expect(inRect(r, 3, 4)).toBe(false)
  })
})

describe('sqlLiteral', () => {
  it('leaves numbers and booleans bare', () => {
    expect(sqlLiteral(4821)).toBe('4821')
    expect(sqlLiteral(true)).toBe('true')
  })

  it('is the NULL keyword, not an empty string', () => {
    expect(sqlLiteral(null)).toBe('NULL')
    expect(sqlLiteral('')).toBe("''")
  })

  it("doubles a quote so O'Brien survives the round trip", () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'")
  })

  it('quotes a numeric-looking string, because the grid cannot know the type', () => {
    expect(sqlLiteral('007')).toBe("'007'")
  })
})

describe('inList', () => {
  it('keeps duplicates and NULLs, in the order selected', () => {
    expect(inList([4821, 4822, 4821, null])).toBe('4821, 4822, 4821, NULL')
  })

  it('is empty for no values', () => {
    expect(inList([])).toBe('')
  })
})

describe('csvField', () => {
  it('quotes only what has to be quoted', () => {
    expect(csvField('acme ltd')).toBe('acme ltd')
    expect(csvField('acme, ltd')).toBe('"acme, ltd"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('two\nlines')).toBe('"two\nlines"')
  })

  it('distinguishes NULL from the empty string', () => {
    expect(csvField(null)).toBe('')
    expect(csvField('')).toBe('""')
  })
})

describe('csv', () => {
  it('leads with the column names', () => {
    const out = csv(
      ['id', 'name'],
      [
        [4821, 'acme ltd'],
        [4822, 'beta, plc'],
      ],
    )
    expect(out).toBe('id,name\n4821,acme ltd\n4822,"beta, plc"')
  })
})

describe('csv formula defusing', () => {
  it('prefixes cells a spreadsheet would run, in the file export only', () => {
    for (const evil of [
      '=1+1',
      '+SUM(A1)',
      '-2+3',
      '@SUM(A1)',
      '\tx',
      '\rx',
      '=HYPERLINK("http://x","y")',
    ]) {
      expect(csvField(evil, true).replace(/^"/, '').startsWith("'")).toBe(true)
      expect(csvField(evil)).not.toContain("'")
    }
  })
  it('defuses the header row too', () => {
    expect(csv(['=a'], [['x']], true)).toBe("'=a\nx")
  })
  it('leaves ordinary text, numbers and bare numeric strings alone', () => {
    for (const ok of ['acme', '-5.25', '+7', '1e5', 'a=b', '']) {
      expect(csvField(ok, true)).toBe(csvField(ok))
    }
    expect(csvField(-3 as unknown as string, true)).toBe('-3')
  })
  it('quotes after prefixing', () => {
    expect(csvField('=a,b', true)).toBe('"\'=a,b"')
  })
  it('keeps the clipboard path byte-faithful', () => {
    expect(selectionText(['a', 'b'], [['=1', 'x']])).toBe('a,b\n=1,x')
  })
})

describe('selectionText', () => {
  it('is the bare value for one cell, so it pastes anywhere', () => {
    expect(selectionText(['name'], [["O'Brien"]])).toBe("O'Brien")
    expect(selectionText(['name'], [[null]])).toBe('')
  })

  it('is an IN list for one column', () => {
    expect(selectionText(['id'], [[1], [2], [3]])).toBe('1, 2, 3')
  })

  it('is CSV as soon as a second column is in the range', () => {
    expect(selectionText(['id', 'name'], [[1, 'a']])).toBe('id,name\n1,a')
  })
})

describe('describeCopy', () => {
  it('says which format was used', () => {
    expect(describeCopy(['id'], [[1]])).toBe('Copied the cell')
    expect(describeCopy(['id'], [[1], [2]])).toBe('Copied 2 values as an IN list')
    expect(
      describeCopy(
        ['id', 'name'],
        [
          [1, 'a'],
          [2, 'b'],
        ],
      ),
    ).toBe('Copied 4 cells as CSV (2 rows × 2 columns)')
  })
})
