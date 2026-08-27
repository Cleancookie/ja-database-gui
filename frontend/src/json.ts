// JSON detection and shaping for the cell viewer.
//
// Kept out of the component so the decisions that actually have edge cases —
// what counts as JSON, when a document is too big to walk — are testable
// without rendering anything.

/**
 * The largest document the tree view will attempt.
 *
 * A cell can legitimately hold megabytes, and the collapsible view builds a
 * React element per node; past this size parsing and rendering costs more than
 * the reader gains, and the plain text view is still there.
 */
export const JSON_VIEW_MAX_CHARS = 1_000_000

export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

/**
 * A cheap pre-check before spending a parse on a megabyte of prose.
 *
 * Only objects and arrays count. A bare `123` or `"a"` is valid JSON by the
 * spec, but a number column is not something anyone wants a tree view of, and
 * treating every integer as JSON would put a pointless tab on every cell.
 */
export function looksLikeJson(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('{') || t.startsWith('[')
}

export type JsonParse = { ok: true; value: unknown } | { ok: false; reason: string }

/**
 * Parses text as a JSON document, refusing anything the tree view cannot
 * usefully show. A truncated value fails here, which is the common case: the
 * grid holds the first 512 characters of a document, and the viewer offers to
 * fetch the rest.
 */
export function parseJson(text: string): JsonParse {
  if (!looksLikeJson(text)) return { ok: false, reason: 'not a JSON object or array' }
  if (text.length > JSON_VIEW_MAX_CHARS) {
    return { ok: false, reason: 'too large to render as a tree' }
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'invalid JSON' }
  }
}

export function jsonKind(value: unknown): JsonKind {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'object':
      return 'object'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'string'
  }
}

/** Children of a container, as [key, value] pairs in document order. */
export function jsonEntries(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) return value.map((v, i) => [String(i), v])
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>)
  return []
}

/**
 * What a collapsed container shows. The count is the point: it is what lets
 * someone decide whether to open a node without opening it.
 */
export function summarise(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 1 ? '[ 1 item ]' : `[ ${value.length} items ]`
  }
  const n = Object.keys(value as Record<string, unknown>).length
  return n === 1 ? '{ 1 key }' : `{ ${n} keys }`
}

/** The root of every path the viewer builds, as JSONPath spells it. */
export const JSON_PATH_ROOT = '$'

/** A key that needs no quoting inside a path. */
const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * The JSONPath of a child, given its parent's path.
 *
 * Built on the way *down* the tree, one segment at a time, so a node knows its
 * own path without a second walk to find it. Array children are bracketed by
 * index; object keys are dotted when they are bare identifiers and quoted
 * otherwise — a key holding a dot or a space would otherwise produce a path
 * that addresses something else when pasted back into a query.
 */
export function jsonPathChild(parent: string, key: string, inArray: boolean): string {
  if (inArray) return `${parent}[${key}]`
  if (BARE_KEY.test(key)) return `${parent}.${key}`
  return `${parent}['${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`
}

/**
 * What "copy value" puts on the clipboard.
 *
 * A string copies as its own text, without the quotes: someone copying a
 * postcode out of a document wants to paste a postcode. Containers have no
 * bare form, so they copy as re-indented JSON. The quoted form is
 * `formatJson`, offered alongside this one.
 */
export function jsonValueText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') return formatJson(value)
  return String(value)
}

/** Re-indented JSON, for the text view and for copying. */
export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** Byte counts as the grid and the viewer report them. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
