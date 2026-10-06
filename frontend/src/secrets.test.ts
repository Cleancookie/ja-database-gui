import { describe, expect, it } from 'vitest'
import { isPasswordRequired, needsPasswordPrompt, storageWarning } from './secrets'
import type { Connection } from './types'

const conn = (askPassword: boolean): Connection => ({
  id: 'a',
  name: 'n',
  kind: 'mysql',
  askPassword,
})

describe('storageWarning', () => {
  it('stays quiet for the keyring and before the backend is known', () => {
    expect(storageWarning(null)).toBeNull()
    expect(storageWarning({ kind: 'keyring' })).toBeNull()
  })

  it('says plainly that the file fallback is not secure, and why', () => {
    const w = storageWarning({ kind: 'file', reason: 'no dbus' })!
    expect(w.level).toBe('warn')
    expect(w.headline).toContain('NOT stored securely')
    expect(w.detail).toContain('no dbus')
    expect(w.detail).toContain('throwaway dev machine')
  })

  it('is an error when the keyring has gone away', () => {
    expect(storageWarning({ kind: 'unavailable' })!.level).toBe('error')
  })
})

describe('needsPasswordPrompt', () => {
  it.each([
    [conn(true), false, null, true],
    [conn(true), true, null, false],
    [conn(true), false, '', false],
    [conn(false), false, null, false],
    [undefined, false, null, false],
  ])('%j connected=%s password=%s -> %s', (c, connected, pw, want) => {
    expect(needsPasswordPrompt(c, connected, pw)).toBe(want)
  })
})

describe('isPasswordRequired', () => {
  it('recognises the Go error', () => {
    expect(isPasswordRequired('PASSWORD_REQUIRED: this connection asks')).toBe(true)
    expect(isPasswordRequired('connection refused')).toBe(false)
  })
})
