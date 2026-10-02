import { describe, expect, it } from 'vitest'
import { sampleResetWarning } from './sample'

describe('sampleResetWarning', () => {
  it('warns that edits are lost', () => {
    expect(sampleResetWarning(false)).toMatch(/changes you made .* are lost/)
  })

  it('mentions the reconnect only when the sample is open', () => {
    expect(sampleResetWarning(false)).not.toMatch(/reopened/)
    expect(sampleResetWarning(true)).toMatch(/reopened/)
  })
})
