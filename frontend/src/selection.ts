/**
 * The grid's cell range, and what copying one puts on the clipboard.
 *
 * The shape of the selection decides the format, and nothing else does — there
 * is no setting. One cell is the value as it stands, one column is an `IN` list,
 * anything wider is CSV. That is enough to cover pasting into a WHERE clause,
 * into a spreadsheet, and into a chat window, without asking the user which of
 * nine formats they meant.
 *
 * Values are taken verbatim: duplicates and NULLs are kept. A list that quietly
 * differs from what was selected is worse than one with a useless NULL in it,
 * which the user can see and delete.
 */

import type { Cell } from './types'

export interface CellPos {
  row: number
  col: number
}

/**
 * A rectangle of cells, anchored where the selection started, plus any ranges
 * kept by Ctrl+click before it. Only the live range moves with the keys.
 */
export interface Selection {
  anchor: CellPos
  focus: CellPos
  kept?: Rect[]
}

export interface Rect {
  top: number
  left: number
  bottom: number
  right: number
}

/** The selection as an ordered rectangle, whichever way it was dragged. */
export function rectOf(sel: Selection): Rect {
  return {
    top: Math.min(sel.anchor.row, sel.focus.row),
    bottom: Math.max(sel.anchor.row, sel.focus.row),
    left: Math.min(sel.anchor.col, sel.focus.col),
    right: Math.max(sel.anchor.col, sel.focus.col),
  }
}

export function inRect(r: Rect, row: number, col: number): boolean {
  return row >= r.top && row <= r.bottom && col >= r.left && col <= r.right
}

/** Every range selected: the kept ones, then the live one. */
export function rectsOf(sel: Selection): Rect[] {
  return [...(sel.kept ?? []), rectOf(sel)]
}

export function inAny(rects: Rect[], row: number, col: number): boolean {
  return rects.some((r) => inRect(r, row, col))
}

const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

/**
 * The rows and columns the selection touches: one table with the gaps closed.
 * Cells in it that were not selected copy as empty fields.
 */
export function gridOf(rects: Rect[]): { rows: number[]; cols: number[] } {
  // One range is the common case and may be a whole result: no enumerating.
  if (rects.length === 1) {
    const [r] = rects
    return { rows: span(r.top, r.bottom), cols: span(r.left, r.right) }
  }
  const cells = cellsOf(rects)
  const rows = [...new Set(cells.map((c) => c.row))].sort((a, b) => a - b)
  const cols = [...new Set(cells.map((c) => c.col))].sort((a, b) => a - b)
  return { rows, cols }
}

/** The distinct selected cells, in reading order. */
export function cellsOf(rects: Rect[]): CellPos[] {
  const seen = new Set<string>()
  const out: CellPos[] = []
  for (const r of rects) {
    for (let row = r.top; row <= r.bottom; row++) {
      for (let col = r.left; col <= r.right; col++) {
        const k = `${row}:${col}`
        if (seen.has(k)) continue
        seen.add(k)
        out.push({ row, col })
      }
    }
  }
  return out.sort((a, b) => a.row - b.row || a.col - b.col)
}

/**
 * What copying the selection produces, clamped to the result — one can be
 * replaced under a selection by a smaller page or a narrower filter.
 *
 * Always a table (see selectionText), so several ranges copy the same way
 * one does: scattered cells keep their own row and column, blank elsewhere.
 */
export function copyOf(
  sel: Selection,
  names: string[],
  data: Cell[][],
): { text: string; what: string; rects: Rect[] } | null {
  const rects = rectsOf(sel)
    .map((r) => ({
      top: Math.max(0, r.top),
      left: Math.max(0, r.left),
      bottom: Math.min(data.length - 1, r.bottom),
      right: Math.min(names.length - 1, r.right),
    }))
    .filter((r) => r.bottom >= r.top && r.right >= r.left)
  if (rects.length === 0) return null
  const g = gridOf(rects)
  const columns = g.cols.map((c) => names[c])
  const rows = g.rows.map((r) => g.cols.map((c) => (inAny(rects, r, c) ? data[r][c] : null)))
  return { text: selectionText(columns, rows), what: describeCopy(columns, rows), rects }
}

export function rectSize(r: Rect): { rows: number; cols: number; cells: number } {
  const rows = r.bottom - r.top + 1
  const cols = r.right - r.left + 1
  return { rows, cols, cells: rows * cols }
}

/**
 * A value as a SQL literal. Text is single-quoted with '' escaping, numbers and
 * booleans are bare, NULL is the keyword.
 *
 * A numeric-looking string stays quoted, because the grid cannot know whether
 * the column is text: every engine this app targets accepts `id in ('1')` for
 * an integer column, while `name in (1)` is an error on some.
 */
export function sqlLiteral(v: Cell): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return String(v)
  return `'${v.replace(/'/g, "''")}'`
}

/** One column of values, ready to paste between the brackets of an `IN (…)`. */
export function inList(values: Cell[]): string {
  return values.map(sqlLiteral).join(', ')
}

/**
 * One CSV field. Quoted only where it has to be, so a plain list of ids stays
 * readable.
 *
 * NULL is an empty field and an empty string is a quoted empty field, which is
 * the only way CSV can tell them apart at all — and telling them apart is half
 * of why the grid marks them differently in the first place.
 */
export function csvField(v: Cell, safe = false): string {
  if (v === null) return ''
  if (typeof v !== 'string') return String(v)
  if (safe) v = defuseFormula(v)
  if (v === '') return '""'
  if (/["\n\r,]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

const FORMULA_START = /^[=+\-@\t\r]/
// Decimals travel as strings (see scan.go), and "-5.25" is a number to a
// spreadsheet, not a formula. Anything longer than a bare number is still defused.
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/

/**
 * Spreadsheet formula injection: a cell that starts with = + - @ tab or CR is
 * run as a formula when the file is opened in Excel or Sheets. A leading
 * apostrophe makes it text; the apostrophe is the one deliberate change to the
 * value. Only the file export uses this; the clipboard stays byte-faithful.
 */
export function defuseFormula(v: string): string {
  return FORMULA_START.test(v) && !PLAIN_NUMBER.test(v) ? `'${v}` : v
}

/**
 * CSV with a header row of column names.
 *
 * `safe` defuses spreadsheet formulas, for a file that will be opened in a
 * spreadsheet. Leave it off for text that goes straight to the clipboard.
 *
 * The header is always included: the point of copying a block out of a grid is
 * to paste it somewhere that has lost the grid, and unlabelled columns are the
 * first thing anyone asks about.
 */
export function csv(columns: string[], rows: Cell[][], safe = false): string {
  const field = (v: Cell) => csvField(v, safe)
  return [columns.map(field).join(','), ...rows.map((r) => r.map(field).join(','))].join('\n')
}

/**
 * What copying the selection produces.
 *
 * `columns` and `rows` are already narrowed to the selected rectangle.
 */
export function selectionText(columns: string[], rows: Cell[][]): string {
  if (rows.length === 1 && columns.length === 1) {
    const v = rows[0][0]
    // A single cell is its own value, unquoted: this is the "copy what I am
    // looking at" case, and quoting it would break pasting it into anything.
    return v === null ? '' : String(v)
  }
  if (columns.length === 1) return inList(rows.map((r) => r[0]))
  return csv(columns, rows)
}

/** How the copy describes itself in a toast. */
export function describeCopy(columns: string[], rows: Cell[][]): string {
  const cells = rows.length * columns.length
  if (cells === 1) return 'Copied the cell'
  if (columns.length === 1) return `Copied ${rows.length} values as an IN list`
  return `Copied ${cells} cells as CSV (${rows.length} rows × ${columns.length} columns)`
}
