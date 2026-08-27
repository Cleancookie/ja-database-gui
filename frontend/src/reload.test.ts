import { describe, expect, it } from 'vitest'
import { isAppReloadKey } from './reload'

const key = (over: Partial<KeyboardEvent> = {}) =>
  ({ key: 'R', ctrlKey: true, metaKey: false, shiftKey: true, ...over }) as KeyboardEvent

describe('isAppReloadKey', () => {
  it('matches Ctrl+Shift+R', () => {
    expect(isAppReloadKey(key())).toBe(true)
  })

  it('matches Cmd+Shift+R', () => {
    expect(isAppReloadKey(key({ ctrlKey: false, metaKey: true }))).toBe(true)
  })

  it('matches whichever case the platform reports', () => {
    expect(isAppReloadKey(key({ key: 'r' }))).toBe(true)
  })

  // Ctrl+R without Shift already means "refresh the current rows" (App.tsx).
  // Claiming it here would take the data refresh away.
  it('leaves Ctrl+R alone', () => {
    expect(isAppReloadKey(key({ shiftKey: false }))).toBe(false)
  })

  it('needs a modifier', () => {
    expect(isAppReloadKey(key({ ctrlKey: false }))).toBe(false)
  })

  it('ignores other letters', () => {
    expect(isAppReloadKey(key({ key: 'P' }))).toBe(false)
  })
})
