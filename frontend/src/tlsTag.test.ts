import { describe, expect, it } from 'vitest'
import { tlsTag } from './tlsTag'
import type { TlsInfo } from './types'

const info = (p: Partial<TlsInfo>): TlsInfo => ({
  mode: 'x',
  level: 'verified',
  implicit: false,
  label: 'l',
  warn: false,
  ...p,
})

describe('tlsTag', () => {
  it('says nothing for SQLite', () => {
    expect(tlsTag(info({ level: 'na' }))).toBeNull()
  })
  it('marks verified TLS as plain TLS', () => {
    expect(tlsTag(info({}))?.text).toBe('TLS')
  })
  it('calls out an unchecked certificate', () => {
    expect(tlsTag(info({ level: 'encrypted' }))?.text).toBe('TLS unverified')
  })
  it('makes remote plaintext loud and local plaintext quiet', () => {
    expect(tlsTag(info({ level: 'plain', warn: true }))?.colour).toBe('var(--color-danger)')
    expect(tlsTag(info({ level: 'plain' }))?.colour).toBe('var(--color-faint)')
  })
})
