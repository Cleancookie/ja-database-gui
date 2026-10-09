import type { Kind } from './types'

export type FormatterDialect = 'postgresql' | 'mysql' | 'sqlite' | 'transactsql' | 'sql'

/** The sql-formatter dialect for a connection's driver; generic SQL when unknown. */
export function formatterDialect(kind: string | null | undefined): FormatterDialect {
  switch (kind as Kind | 'sqlserver' | null | undefined) {
    case 'postgres':
      return 'postgresql'
    case 'mysql':
      return 'mysql'
    case 'sqlite':
      return 'sqlite'
    case 'mssql':
    case 'sqlserver':
      return 'transactsql'
    default:
      return 'sql'
  }
}

/** Loaded on first use so the formatter adds nothing to launch. */
export async function formatSql(text: string, kind: string | null | undefined): Promise<string> {
  const { format } = await import('sql-formatter')
  return format(text, { language: formatterDialect(kind), tabWidth: 2, keywordCase: 'preserve' })
}
