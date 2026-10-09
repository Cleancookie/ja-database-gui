import { describe, expect, it } from 'vitest'
import { formatterDialect, formatSql } from './sqlFormat'

describe('formatterDialect', () => {
  it.each([
    ['postgres', 'postgresql'],
    ['mysql', 'mysql'],
    ['sqlite', 'sqlite'],
    ['mssql', 'transactsql'],
    ['sqlserver', 'transactsql'],
    ['oracle', 'sql'],
    [null, 'sql'],
    [undefined, 'sql'],
  ])('%s -> %s', (kind, want) => {
    expect(formatterDialect(kind)).toBe(want)
  })
})

describe('formatSql', () => {
  it('breaks clauses onto lines and preserves keyword case', async () => {
    expect(await formatSql('select a,b from t where a=1', 'postgres')).toBe(
      'select\n  a,\n  b\nfrom\n  t\nwhere\n  a = 1',
    )
  })
})
