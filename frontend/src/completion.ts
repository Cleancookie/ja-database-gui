// Completion candidates for the filter box and the SQL editor.
//
// Deliberately free of any editor API: this module decides *what* can be
// completed, `ui/Editor.tsx` decides how it is offered. That split is what
// keeps the candidate rules testable without a DOM, and it is why the editor
// library could be swapped without touching any of this.

import type { Column, Kind, SchemaObject } from './types'

/** What a completion offers. `detail` is the dimmed right-hand text. */
export interface Candidate {
  label: string
  /** Ordering hint; higher wins. Columns of the open table beat keywords. */
  boost: number
  kind: 'column' | 'table' | 'view' | 'keyword' | 'function'
  detail?: string
}

/**
 * Keywords worth completing after WHERE, which is the whole of the filter box
 * and most of what matters in a predicate.
 *
 * Not an attempt at the full grammar — a list long enough to bury the columns
 * would make the popup worse than no popup. Operators the user types as
 * punctuation are left out on purpose.
 */
const PREDICATE_KEYWORDS = [
  'and',
  'or',
  'not',
  'in',
  'like',
  'between',
  'is null',
  'is not null',
  'exists',
  'case',
  'when',
  'then',
  'else',
  'end',
  'asc',
  'desc',
]

/** Statement keywords, only useful in the editor. */
const STATEMENT_KEYWORDS = [
  'select',
  'from',
  'where',
  'group by',
  'having',
  'order by',
  'limit',
  'offset',
  'join',
  'left join',
  'right join',
  'inner join',
  'on',
  'as',
  'distinct',
  'union',
  'union all',
  'with',
  'insert into',
  'values',
  'update',
  'set',
  'delete from',
  'count(*)',
]

/**
 * Functions that differ per dialect. Only the handful people reach for while
 * writing a predicate — a full builtin list per dialect is a maintenance
 * burden that buys very little, since the ones below cover "now", "today" and
 * "lower case compare", which is most ad-hoc filtering.
 */
const FUNCTIONS: Record<Kind, string[]> = {
  mysql: [
    'now()',
    'curdate()',
    'date_sub',
    'interval',
    'lower',
    'upper',
    'concat',
    'ifnull',
    'coalesce',
  ],
  postgres: [
    'now()',
    'current_date',
    'interval',
    'lower',
    'upper',
    'coalesce',
    'date_trunc',
    'age',
  ],
  mssql: ['getdate()', 'dateadd', 'datediff', 'lower', 'upper', 'isnull', 'coalesce', 'convert'],
  sqlite: ["date('now')", "datetime('now')", 'lower', 'upper', 'ifnull', 'coalesce', 'strftime'],
}

/**
 * Boosts, in one place because their *relative* order is the whole design:
 *
 * A predicate is overwhelmingly about the columns of the table in front of
 * you, so those come first. Table names matter in the editor and almost never
 * in the filter box. Keywords come last because they are short, easily typed
 * in full, and there are more of them than anything else.
 */
const BOOST = {
  column: 60,
  primaryKey: 70,
  table: 40,
  view: 35,
  fn: 20,
  keyword: 10,
} as const

export interface CandidateInput {
  /** Columns of the table currently open. Empty in the editor with no table. */
  columns: Column[]
  /** Tables and views in the active database. */
  objects: SchemaObject[]
  kind: Kind | null
  /** Schemas are only worth qualifying with where the dialect has them. */
  hasSchemas: boolean
}

/**
 * Candidates for the filter box: the open table's columns, then predicate
 * keywords and functions. No table names — the table is already chosen, and
 * offering it here only pushes the columns down.
 */
export function filterCandidates(input: CandidateInput): Candidate[] {
  const out: Candidate[] = columnCandidates(input.columns)
  if (input.kind) out.push(...functionCandidates(input.kind))
  for (const k of PREDICATE_KEYWORDS) {
    out.push({ label: k, boost: BOOST.keyword, kind: 'keyword' })
  }
  return out
}

/**
 * Candidates for the SQL editor: everything the filter box offers, plus the
 * objects in the database and the statement keywords.
 *
 * The open table's columns are still included and still ranked top. Knowing
 * which table the user is writing about would need parsing the half-typed
 * statement; offering the columns of the table they were just looking at is a
 * cheap approximation that is right most of the time and never misleading,
 * because the detail text names the table each column came from.
 */
export function editorCandidates(input: CandidateInput, activeTable?: string): Candidate[] {
  const out: Candidate[] = columnCandidates(input.columns, activeTable)
  for (const o of input.objects) {
    if (o.type !== 'table' && o.type !== 'view') continue
    const qualified = input.hasSchemas && o.schema ? `${o.schema}.${o.name}` : o.name
    out.push({
      label: qualified,
      boost: o.type === 'table' ? BOOST.table : BOOST.view,
      kind: o.type,
      detail: o.type,
    })
  }
  if (input.kind) out.push(...functionCandidates(input.kind))
  for (const k of [...STATEMENT_KEYWORDS, ...PREDICATE_KEYWORDS]) {
    out.push({ label: k, boost: BOOST.keyword, kind: 'keyword' })
  }
  return out
}

function columnCandidates(columns: Column[], table?: string): Candidate[] {
  return columns.map((c) => ({
    label: c.name,
    // A primary key is the column most often filtered on, so it outranks its
    // siblings rather than relying on alphabetical luck.
    boost: c.primaryKey ? BOOST.primaryKey : BOOST.column,
    kind: 'column' as const,
    detail: table ? `${c.dataType} · ${table}` : c.dataType,
  }))
}

function functionCandidates(kind: Kind): Candidate[] {
  return FUNCTIONS[kind].map((f) => ({
    label: f,
    boost: BOOST.fn,
    kind: 'function' as const,
    detail: kind,
  }))
}

/**
 * The word being completed, given the text and the caret.
 *
 * Stops at whitespace and at SQL punctuation, but *not* at a dot: typing
 * `users.` should complete against `users.id`, so the qualifier has to stay
 * part of the token. A caret inside a string literal returns null — completing
 * a column name into `'act…'` would be wrong every time.
 */
export function tokenAt(text: string, caret: number): { from: number; word: string } | null {
  if (inStringLiteral(text, caret)) return null
  let from = caret
  while (from > 0 && isWordChar(text[from - 1])) from--
  return { from, word: text.slice(from, caret) }
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_$.]/.test(ch)
}

/**
 * Whether the caret sits inside a quoted string.
 *
 * Counts quotes from the start rather than tracking state, and treats a
 * doubled quote (`''`, the SQL escape) as a closed pair, which it is. Backslash
 * escaping is deliberately not honoured: MySQL does it, standard SQL does not,
 * and guessing wrong in the *permissive* direction only costs a popup that
 * should not have appeared.
 */
function inStringLiteral(text: string, caret: number): boolean {
  let single = false
  let double = false
  for (let i = 0; i < caret; i++) {
    const ch = text[i]
    if (ch === "'" && !double) single = !single
    else if (ch === '"' && !single) double = !double
  }
  return single || double
}
