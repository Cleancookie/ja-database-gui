// JSON detection and shaping for the cell viewer.
//
// Kept out of the component so the decisions that actually have edge cases —
// what counts as JSON, when a document is too big to walk — are testable
// without rendering anything.

import type { JSONEdit } from './types'

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

// ---- Editing by path -----------------------------------------------------------

/** One step into a document: an object key, or an array index. */
export type JsonSeg = string | number

/** The JSONPath of a node, from its segments. */
export function jsonPathOf(segs: JsonSeg[]): string {
  return segs.reduce<string>(
    (p, s) => jsonPathChild(p, String(s), typeof s === 'number'),
    JSON_PATH_ROOT,
  )
}

/** A value's extent in the text, as [start, end). */
interface Span {
  start: number
  end: number
}

/** One child of a container. For an array member the key span is empty. */
interface Member {
  key: string | null
  keyStart: number
  keyEnd: number
  value: Span
}

interface Container {
  isObject: boolean
  open: number
  close: number
  members: Member[]
}

const WS = /\s/

function skipWs(t: string, i: number): number {
  while (i < t.length && WS.test(t[i])) i++
  return i
}

/** At an opening quote: the index just past the closing one. */
function stringEnd(t: string, i: number): number {
  let j = i + 1
  while (j < t.length && t[j] !== '"') j += t[j] === '\\' ? 2 : 1
  return j + 1
}

/** At the first character of a value: the index just past it. Text must be valid JSON. */
function valueEnd(t: string, i: number): number {
  const c = t[i]
  if (c === '"') return stringEnd(t, i)
  if (c !== '{' && c !== '[') {
    let j = i
    while (j < t.length && !/[\s,\]}]/.test(t[j])) j++
    return j
  }
  // A depth count rather than a recursive walk: skipping a nested container is
  // the common case and needs none of its structure.
  let depth = 0
  let j = i
  while (j < t.length) {
    const ch = t[j]
    if (ch === '"') {
      j = stringEnd(t, j)
      continue
    }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return j + 1
    }
    j++
  }
  return j
}

/** The members of the container starting at `i`, with their spans. */
function readContainer(t: string, i: number): Container {
  const isObject = t[i] === '{'
  const members: Member[] = []
  let j = skipWs(t, i + 1)
  if (t[j] === (isObject ? '}' : ']')) return { isObject, open: i, close: j, members }
  for (;;) {
    let key: string | null = null
    const keyStart = j
    let keyEnd = j
    if (isObject) {
      keyEnd = stringEnd(t, j)
      key = JSON.parse(t.slice(keyStart, keyEnd)) as string
      j = skipWs(t, skipWs(t, keyEnd) + 1) // past the colon
    }
    const end = valueEnd(t, j)
    members.push({ key, keyStart, keyEnd, value: { start: j, end } })
    j = skipWs(t, end)
    if (t[j] !== ',') return { isObject, open: i, close: j, members }
    j = skipWs(t, j + 1)
  }
}

/**
 * Which member a segment names. A repeated key resolves to its last
 * occurrence, which is the one JSON.parse — and so the tree — shows.
 */
function memberIndex(c: Container, seg: JsonSeg): number {
  if (!c.isObject) {
    const n = Number(seg)
    return Number.isInteger(n) && n >= 0 && n < c.members.length ? n : -1
  }
  const key = String(seg)
  for (let k = c.members.length - 1; k >= 0; k--) if (c.members[k].key === key) return k
  return -1
}

function isContainerAt(t: string, i: number): boolean {
  return t[i] === '{' || t[i] === '['
}

/** The span of the value at `segs`, or a reason it is not there. */
function locate(
  t: string,
  segs: JsonSeg[],
): { ok: true; span: Span } | { ok: false; reason: string } {
  let start = skipWs(t, 0)
  for (let n = 0; n < segs.length; n++) {
    if (!isContainerAt(t, start)) {
      return { ok: false, reason: `${jsonPathOf(segs.slice(0, n))} is not an object or array` }
    }
    const c = readContainer(t, start)
    const k = memberIndex(c, segs[n])
    if (k < 0) return { ok: false, reason: `${jsonPathOf(segs.slice(0, n + 1))} does not exist` }
    start = c.members[k].value.start
  }
  return { ok: true, span: { start, end: valueEnd(t, start) } }
}

/**
 * The exact text of the value at `segs`, as it sits in the document — so an
 * editor opens on `12345678901234567890`, not on the float JSON.parse made of it.
 */
export function jsonSourceAt(text: string, segs: JsonSeg[]): string | null {
  const at = locate(text, segs)
  return at.ok ? text.slice(at.span.start, at.span.end) : null
}

export type JsonEditResult = { ok: true; text: string } | { ok: false; reason: string }

const splice = (t: string, start: number, end: number, insert: string) =>
  t.slice(0, start) + insert + t.slice(end)

/**
 * A new last member for `c`, laid out like the members already there: same
 * line breaks and indent, same space after a colon.
 */
function appendMember(t: string, c: Container, body: string): string {
  const last = c.members.at(-1)
  if (!last) return splice(t, c.open + 1, c.open + 1, body)
  const prev = c.members.length > 1 ? c.members[c.members.length - 2].value.end : c.open + 1
  const lead = t.slice(prev, last.keyStart === last.keyEnd ? last.value.start : last.keyStart)
  const comma = lead.indexOf(',')
  return splice(
    t,
    last.value.end,
    last.value.end,
    ',' + (comma < 0 ? lead : lead.slice(comma + 1)) + body,
  )
}

function removeMember(t: string, c: Container, k: number): string {
  const m = c.members
  const startOf = (x: Member) => (c.isObject ? x.keyStart : x.value.start)
  if (m.length === 1) return splice(t, c.open + 1, c.close, '')
  if (k < m.length - 1) return splice(t, startOf(m[k]), startOf(m[k + 1]), '')
  return splice(t, m[k - 1].value.end, m[k].value.end, '')
}

function checkValue(v: string | undefined): string | null {
  if (v === undefined) return 'no value given'
  try {
    JSON.parse(v)
    return null
  } catch (e) {
    return `invalid JSON: ${e instanceof Error ? e.message : String(e)}`
  }
}

function applyOne(t: string, e: JSONEdit): JsonEditResult {
  if (e.op === 'set' || e.op === 'append') {
    const bad = checkValue(e.value)
    if (bad) return { ok: false, reason: bad }
  }
  const value = e.value ?? ''

  if (e.op === 'append') {
    const at = locate(t, e.path)
    if (!at.ok) return at
    if (t[at.span.start] !== '[')
      return { ok: false, reason: `${jsonPathOf(e.path)} is not an array` }
    return { ok: true, text: appendMember(t, readContainer(t, at.span.start), value) }
  }

  if (e.path.length === 0) {
    if (e.op === 'set') return { ok: true, text: value }
    return { ok: false, reason: `cannot ${e.op} the whole document` }
  }

  const parentPath = e.path.slice(0, -1)
  const seg = e.path[e.path.length - 1]
  const parent = locate(t, parentPath)
  if (!parent.ok) return parent
  if (!isContainerAt(t, parent.span.start)) {
    return { ok: false, reason: `${jsonPathOf(parentPath)} is not an object or array` }
  }
  const c = readContainer(t, parent.span.start)
  const k = memberIndex(c, seg)
  const missing = { ok: false, reason: `${jsonPathOf(e.path)} does not exist` } as const

  switch (e.op) {
    case 'set': {
      if (k >= 0)
        return {
          ok: true,
          text: splice(t, c.members[k].value.start, c.members[k].value.end, value),
        }
      if (!c.isObject) return missing
      const ref = c.members.at(-1)
      const colon = ref ? t.slice(ref.keyEnd, ref.value.start) : ': '
      return { ok: true, text: appendMember(t, c, JSON.stringify(String(seg)) + colon + value) }
    }
    case 'remove':
      return k < 0 ? missing : { ok: true, text: removeMember(t, c, k) }
    case 'rename': {
      if (!c.isObject) return { ok: false, reason: 'only an object key can be renamed' }
      if (k < 0) return missing
      if (e.newKey === undefined) return { ok: false, reason: 'no new key given' }
      if (e.newKey === String(seg)) return { ok: true, text: t }
      if (memberIndex(c, e.newKey) >= 0) {
        return { ok: false, reason: `${jsonPathOf([...parentPath, e.newKey])} already exists` }
      }
      const m = c.members[k]
      return { ok: true, text: splice(t, m.keyStart, m.keyEnd, JSON.stringify(e.newKey)) }
    }
  }
}

/**
 * Applies path edits to a JSON document, in order, by splicing its text.
 *
 * Splicing rather than parse-edit-stringify, for the reason `reformatJson`
 * gives: a round trip through JSON.parse rounds a 20-digit integer, turns `1.0`
 * into `1` and drops a repeated key. Here every byte outside the edited spans
 * is left exactly as it was, and a new member copies its neighbours' layout.
 *
 * This is the client's preview of what the server will do to the stored value;
 * the server applies the same edits to whatever the column holds when the
 * change set runs.
 */
export function applyJsonEdits(text: string, edits: readonly JSONEdit[]): JsonEditResult {
  try {
    JSON.parse(text)
  } catch {
    return { ok: false, reason: 'the value is not valid JSON' }
  }
  let t = text
  for (const e of edits) {
    const r = applyOne(t, e)
    if (!r.ok) return r
    t = r.text
  }
  return { ok: true, text: t }
}
