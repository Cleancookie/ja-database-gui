/**
 * The pure parts of the record pane down the right edge: which columns a
 * search keeps, and where a click on one sends the grid.
 */

import { matchPositions, rankCandidates } from './fuzzy'
import type { ResultSource } from './store'

export interface ColumnHit {
  /** Index into the result's columns. */
  index: number
  /** Matched characters of the name, for highlighting. */
  positions: number[]
}

/**
 * The columns matching `query`, best first, through the palette's matcher and
 * cutoff. An empty query keeps every column in result order.
 */
export function filterColumns(query: string, names: string[]): ColumnHit[] {
  const q = query.trim()
  if (!q) return names.map((_, index) => ({ index, positions: [] }))
  const indexes = names.map((_, i) => i)
  return rankCandidates(q, indexes, (i) => ({ name: names[i] })).map(({ item }) => ({
    index: item,
    positions: matchPositions(q, { name: names[item] }),
  }))
}

/**
 * What a click on a column does: with a row under the cursor, select that cell
 * so the grid scrolls to it; with none, only bring the column into view.
 */
export type ColumnJump =
  { kind: 'select'; row: number; col: number } | { kind: 'reveal'; col: number }

export function columnJump(row: number | null, col: number, rowCount: number): ColumnJump {
  if (row !== null && row >= 0 && row < rowCount) return { kind: 'select', row, col }
  return { kind: 'reveal', col }
}

type Listener = (col: number) => void
const listeners = new Map<ResultSource, Set<Listener>>()

/** Asks the grid showing `source` to scroll `col` into view, selection untouched. */
export function revealColumn(source: ResultSource, col: number) {
  for (const fn of listeners.get(source) ?? []) fn(col)
}

/** Subscribes a grid to `revealColumn`; returns the unsubscribe. */
export function onRevealColumn(source: ResultSource, fn: Listener): () => void {
  let set = listeners.get(source)
  if (!set) listeners.set(source, (set = new Set()))
  set.add(fn)
  return () => set.delete(fn)
}
