import { describe, expect, it } from 'vitest'
import { selectionToRun } from './sqlRun'

const doc = 'select 1;\nselect 2;\n   \n'

describe('selectionToRun', () => {
  it('is null for a caret', () => {
    expect(selectionToRun(doc, [{ from: 3, to: 3 }])).toBeNull()
  })
  it('is null with no ranges', () => {
    expect(selectionToRun(doc, [])).toBeNull()
  })
  it('returns the trimmed selection', () => {
    expect(selectionToRun(doc, [{ from: 9, to: 20 }])).toBe('select 2;')
  })
  it('handles a backwards selection', () => {
    expect(selectionToRun(doc, [{ from: 9, to: 0 }])).toBe('select 1;')
  })
  it('ignores a whitespace-only selection', () => {
    expect(selectionToRun(doc, [{ from: 20, to: 24 }])).toBeNull()
  })
  it('keeps several statements as-is', () => {
    expect(selectionToRun(doc, [{ from: 0, to: 19 }])).toBe('select 1;\nselect 2;')
  })
  it('uses the main range only', () => {
    const ranges = [
      { from: 0, to: 9 },
      { from: 10, to: 19 },
    ]
    expect(selectionToRun(doc, ranges, 1)).toBe('select 2;')
    expect(selectionToRun(doc, ranges, 0)).toBe('select 1;')
  })
})
