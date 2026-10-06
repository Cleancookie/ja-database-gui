import { describe, expect, it } from 'vitest'
import {
  effectiveIsolation,
  isolationChoices,
  isolationLabel,
  ISOLATION_WARNING,
} from './isolation'

describe('isolation choices', () => {
  it('leads with the driver default and then the dialect list in order', () => {
    expect(isolationChoices(['read committed', 'snapshot']).map((c) => c.value)).toEqual([
      '',
      'read committed',
      'snapshot',
    ])
  })

  it('offers only the default where the dialect has nothing to choose', () => {
    expect(isolationChoices([])).toEqual([{ value: '', label: 'Driver default' }])
    expect(isolationChoices(undefined)).toHaveLength(1)
  })

  it('labels levels for people', () => {
    expect(isolationLabel('')).toBe('Driver default')
    expect(isolationLabel('repeatable read')).toBe('Repeatable read')
    expect(isolationLabel('unknown')).toBe('unknown')
  })
})

describe('effectiveIsolation', () => {
  const mssql = [
    'read uncommitted',
    'read committed',
    'repeatable read',
    'snapshot',
    'serializable',
  ]
  const mysql = ['read uncommitted', 'read committed', 'repeatable read', 'serializable']

  it('keeps a level the dialect offers', () => {
    expect(effectiveIsolation(mssql, 'snapshot')).toBe('snapshot')
  })

  it('falls back to the default when the tab moved to a dialect without it', () => {
    expect(effectiveIsolation(mysql, 'snapshot')).toBe('')
    expect(effectiveIsolation([], 'serializable')).toBe('')
    expect(effectiveIsolation(undefined, 'serializable')).toBe('')
  })

  it('never invents a level from the default', () => {
    expect(effectiveIsolation(mysql, '')).toBe('')
  })
})

describe('the warning', () => {
  it('says each run is wrapped in a transaction and names the statements that break', () => {
    expect(ISOLATION_WARNING).toMatch(/transaction/)
    expect(ISOLATION_WARNING).toMatch(/VACUUM/)
  })
})
