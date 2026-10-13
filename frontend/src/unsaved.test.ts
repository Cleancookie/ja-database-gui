import { describe, expect, it } from 'vitest'
import { hasUnsavedChanges } from './unsaved'

describe('hasUnsavedChanges', () => {
  it('is false with nothing staged', () => {
    expect(hasUnsavedChanges({ stagedSummary: { total: 0 } })).toBe(false)
  })
  it('is true with any staged change', () => {
    expect(hasUnsavedChanges({ stagedSummary: { total: 1 } })).toBe(true)
  })
})
