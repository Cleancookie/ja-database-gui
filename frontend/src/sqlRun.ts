/** One selection range in the editor, as offsets into the document. */
export interface SelectionRange {
  from: number
  to: number
}

/**
 * The text Run should send, or null to run the whole buffer as before.
 *
 * Only the main range counts: with several cursors the main one is the one the
 * user last placed, and stitching ranges together would invent a statement
 * nobody wrote. Whitespace-only selections are ignored so a stray drag over a
 * blank line does not turn Run into "run nothing".
 */
export function selectionToRun(
  doc: string,
  ranges: readonly SelectionRange[],
  main = 0,
): string | null {
  const r = ranges[main] ?? ranges[0]
  if (!r || r.from === r.to) return null
  const text = doc.slice(Math.min(r.from, r.to), Math.max(r.from, r.to)).trim()
  return text === '' ? null : text
}
