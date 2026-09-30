/**
 * Deciding how a cell is edited and whether the result may be staged.
 *
 * Pure, so the thresholds and the JSON rules are tested without an editor.
 */

import { looksLikeJson } from './json'

/** Longer than this and a one-row field is the wrong tool. */
export const LARGE_CHARS = 200

/** json and jsonb, which the database itself will refuse if they are not JSON. */
export function isJsonType(dataType: string): boolean {
  return /json/i.test(dataType)
}

/**
 * Whether F2 should open the large editor rather than the inline field: a long
 * value, more than one line, or a column type that holds documents.
 */
export function wantsLarge(text: string, dataType: string): boolean {
  return text.length > LARGE_CHARS || text.includes('\n') || /json|xml/i.test(dataType)
}

export type JsonStatus =
  { state: 'empty' } | { state: 'valid' } | { state: 'invalid'; message: string }

/** Whether the text parses as JSON — any JSON value, since json columns accept them all. */
export function jsonStatus(text: string): JsonStatus {
  if (text.trim() === '') return { state: 'empty' }
  try {
    JSON.parse(text)
    return { state: 'valid' }
  } catch (e) {
    return { state: 'invalid', message: e instanceof Error ? e.message : 'invalid JSON' }
  }
}

/**
 * Why this text cannot be staged, or null. Only a json/jsonb column refuses: a
 * text column may hold anything, including half a JSON document, and telling its
 * owner otherwise would be guessing.
 */
export function stageBlock(text: string, dataType: string): string | null {
  if (!isJsonType(dataType)) return null
  const st = jsonStatus(text)
  if (st.state === 'valid') return null
  return st.state === 'empty'
    ? 'A json column cannot hold an empty string'
    : `Invalid JSON: ${st.message}`
}

/** Whether the editor should open with JSON highlighting and tools. */
export function wantsJsonTools(text: string, dataType: string): boolean {
  return isJsonType(dataType) || looksLikeJson(text)
}

/**
 * Re-indents or minifies JSON text by touching only the whitespace between
 * tokens. Parsing and re-stringifying would be shorter and would quietly change
 * the data: a 20-digit integer becomes a rounded float, `1.0` becomes `1`, and
 * a repeated key disappears. A value a person pretty-prints must still be the
 * value they had.
 *
 * `indent` null minifies. The text must already be valid JSON.
 */
export function reformatJson(text: string, indent: number | null): string {
  const out: string[] = []
  const pad = (n: number) => (indent === null ? '' : '\n' + ' '.repeat(indent * n))
  let depth = 0
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out.push(text.slice(i, j + 1))
      i = j + 1
    } else if (c === '{' || c === '[') {
      // An empty container stays `{}` / `[]`.
      let j = i + 1
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] === (c === '{' ? '}' : ']')) {
        out.push(c + text[j])
        i = j + 1
      } else {
        depth++
        out.push(c, pad(depth))
        i++
      }
    } else if (c === '}' || c === ']') {
      depth--
      out.push(pad(depth), c)
      i++
    } else if (c === ',') {
      out.push(',', pad(depth))
      i++
    } else if (c === ':') {
      out.push(indent === null ? ':' : ': ')
      i++
    } else if (/\s/.test(c)) {
      i++
    } else {
      let j = i
      while (j < n && !/[\s,:{}[\]"]/.test(text[j])) j++
      out.push(text.slice(i, j))
      i = j
    }
  }
  return out.join('')
}
