import { describe, expect, it } from 'vitest'
import { editorCandidates, filterCandidates, tokenAt } from './completion'
import type { Column, SchemaObject } from './types'

const col = (name: string, dataType = 'text', primaryKey = false): Column => ({
  name,
  dataType,
  nullable: true,
  primaryKey,
  ordinal: 0,
})

const obj = (
  name: string,
  schema = 'public',
  type: SchemaObject['type'] = 'table',
): SchemaObject => ({
  schema,
  name,
  type,
})

const base = { columns: [], objects: [], kind: null, hasSchemas: false }

describe('filterCandidates', () => {
  it('offers the open table columns above keywords', () => {
    const out = filterCandidates({ ...base, columns: [col('status')] })
    const status = out.find((c) => c.label === 'status')!
    const and = out.find((c) => c.label === 'and')!
    expect(status.boost).toBeGreaterThan(and.boost)
  })

  it('ranks a primary key above its sibling columns', () => {
    const out = filterCandidates({ ...base, columns: [col('email'), col('id', 'int', true)] })
    const id = out.find((c) => c.label === 'id')!
    const email = out.find((c) => c.label === 'email')!
    expect(id.boost).toBeGreaterThan(email.boost)
  })

  it('offers no table names — the table is already chosen', () => {
    const out = filterCandidates({ ...base, objects: [obj('users')] })
    expect(out.some((c) => c.kind === 'table')).toBe(false)
  })

  it('offers per-dialect functions', () => {
    const my = filterCandidates({ ...base, kind: 'mysql' }).map((c) => c.label)
    const ms = filterCandidates({ ...base, kind: 'mssql' }).map((c) => c.label)
    expect(my).toContain('now()')
    expect(ms).toContain('getdate()')
    expect(ms).not.toContain('now()')
  })

  it('offers nothing dialect-specific with no connection', () => {
    const out = filterCandidates(base)
    expect(out.some((c) => c.kind === 'function')).toBe(false)
    // Keywords are dialect-independent, so they are still there.
    expect(out.some((c) => c.label === 'and')).toBe(true)
  })
})

describe('editorCandidates', () => {
  it('includes tables and views, and marks which is which', () => {
    const out = editorCandidates({
      ...base,
      objects: [obj('users'), obj('active_users', 'public', 'view')],
    })
    expect(out.find((c) => c.label === 'users')?.kind).toBe('table')
    expect(out.find((c) => c.label === 'active_users')?.kind).toBe('view')
  })

  it('qualifies with the schema only where the dialect has schemas', () => {
    const withSchemas = editorCandidates({
      ...base,
      objects: [obj('users', 'auth')],
      hasSchemas: true,
    })
    const without = editorCandidates({
      ...base,
      objects: [obj('users', 'auth')],
      hasSchemas: false,
    })
    expect(withSchemas.some((c) => c.label === 'auth.users')).toBe(true)
    expect(without.some((c) => c.label === 'users')).toBe(true)
  })

  it('skips routines — they are not selectable names', () => {
    const out = editorCandidates({ ...base, objects: [obj('do_thing', 'public', 'procedure')] })
    expect(out.some((c) => c.label === 'do_thing')).toBe(false)
  })

  it('names the table a column came from, since the guess may be wrong', () => {
    const out = editorCandidates({ ...base, columns: [col('id', 'int')] }, 'orders')
    expect(out.find((c) => c.label === 'id')?.detail).toBe('int · orders')
  })

  it('ranks columns above tables above keywords', () => {
    const out = editorCandidates({ ...base, columns: [col('id')], objects: [obj('users')] })
    const boost = (l: string) => out.find((c) => c.label === l)!.boost
    expect(boost('id')).toBeGreaterThan(boost('users'))
    expect(boost('users')).toBeGreaterThan(boost('select'))
  })
})

describe('tokenAt', () => {
  it('returns the word before the caret and where it starts', () => {
    expect(tokenAt('status = act', 12)).toEqual({ from: 9, word: 'act' })
  })

  it('keeps a dot in the token so a qualified name completes', () => {
    expect(tokenAt('users.na', 8)).toEqual({ from: 0, word: 'users.na' })
  })

  it('gives an empty word directly after an operator', () => {
    expect(tokenAt('a = ', 4)).toEqual({ from: 4, word: '' })
  })

  it('suppresses completion inside a string literal', () => {
    expect(tokenAt("status = 'act", 13)).toBeNull()
  })

  it('resumes after a closed literal', () => {
    expect(tokenAt("status = 'active' an", 20)).toEqual({ from: 18, word: 'an' })
  })

  it('treats a doubled quote as the SQL escape, not a new literal', () => {
    // O''Brien is one closed string; the caret after it is not inside a literal.
    expect(tokenAt("name = 'O''Brien' an", 20)).toEqual({ from: 18, word: 'an' })
  })

  it('handles a double-quoted identifier', () => {
    expect(tokenAt('"my col" = x', 12)).toEqual({ from: 11, word: 'x' })
    expect(tokenAt('"my co', 6)).toBeNull()
  })
})
