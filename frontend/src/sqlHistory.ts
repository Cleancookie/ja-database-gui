import type { ResultSet } from './types'

/**
 * Run history for one SQL editor tab, as pure transitions so the rules can be
 * tested without the store.
 *
 * Memory only. Results can hold sensitive data, so nothing here is written to
 * disk, settings or localStorage; closing the editor tab or the app drops it.
 */

/**
 * Most unpinned runs kept. Ten is enough to flip back through a working
 * session; beyond that the tab strip stops being scannable.
 */
export const MAX_UNPINNED_RUNS = 10

/**
 * Most cells (rows x columns) kept across the whole history. The backend lets a
 * single result reach 256 MB, and every kept run stays in the webview's heap.
 * Two million cells is roughly tens of MB of typical rows: several ordinary
 * runs fit, one huge run pushes the older ones out. The newest run is kept even
 * if it alone is over budget, because dropping what was just asked for is worse.
 */
export const MAX_RETAINED_CELLS = 2_000_000

export interface SqlRunEntry {
  id: number
  /** The text that was sent: the selection when there was one. */
  sql: string
  /** Epoch ms when the run was started. */
  at: number
  durationMs: number
  /** Connection and database it ran against, for the tooltip. */
  target: string
  results: ResultSet[]
  /** The batch produced more result sets than were kept. */
  moreResults: boolean
  /** Set when the run failed or was cancelled; there are then no results. */
  error?: string
  pinned: boolean
}

export interface SqlHistory {
  runs: SqlRunEntry[]
  /** Id of the run on screen, null when there is none. */
  activeId: number | null
}

export const emptyHistory: SqlHistory = { runs: [], activeId: null }

export function activeRun(h: SqlHistory): SqlRunEntry | null {
  return h.runs.find((r) => r.id === h.activeId) ?? null
}

export function nextRunId(h: SqlHistory): number {
  return h.runs.reduce((m, r) => Math.max(m, r.id), 0) + 1
}

export function cellsOf(run: SqlRunEntry): number {
  let n = 0
  for (const r of run.results) n += r.rows.length * r.columns.length
  return n
}

/** Drops the oldest unpinned runs, never the active or a pinned one, until both limits hold. */
function evict(h: SqlHistory): SqlHistory {
  let runs = h.runs
  let cells = runs.reduce((n, r) => n + cellsOf(r), 0)
  let unpinned = runs.filter((r) => !r.pinned).length
  for (;;) {
    if (unpinned <= MAX_UNPINNED_RUNS && cells <= MAX_RETAINED_CELLS) break
    const victim = runs.find((r) => !r.pinned && r.id !== h.activeId)
    if (!victim) break
    runs = runs.filter((r) => r !== victim)
    cells -= cellsOf(victim)
    unpinned--
  }
  return runs === h.runs ? h : { ...h, runs }
}

/** Appends a run and makes it the active one. */
export function addRun(h: SqlHistory, run: SqlRunEntry): SqlHistory {
  return evict({ runs: [...h.runs, run], activeId: run.id })
}

export function selectRun(h: SqlHistory, id: number): SqlHistory {
  if (id === h.activeId || !h.runs.some((r) => r.id === id)) return h
  return { ...h, activeId: id }
}

/** The run `delta` places from the active one, wrapping; null when there is nothing to move to. */
export function stepTarget(h: SqlHistory, delta: number): number | null {
  const n = h.runs.length
  if (n < 2) return null
  const i = h.runs.findIndex((r) => r.id === h.activeId)
  const from = i < 0 ? (delta > 0 ? -1 : 0) : i
  return h.runs[(((from + delta) % n) + n) % n].id
}

export function togglePin(h: SqlHistory, id: number): SqlHistory {
  if (!h.runs.some((r) => r.id === id)) return h
  const runs = h.runs.map((r) => (r.id === id ? { ...r, pinned: !r.pinned } : r))
  return evict({ ...h, runs })
}

/** Removes a run. If it was active, the next one along (else the previous) takes over. */
export function closeRun(h: SqlHistory, id: number): SqlHistory {
  const i = h.runs.findIndex((r) => r.id === id)
  if (i < 0) return h
  const runs = h.runs.filter((r) => r.id !== id)
  if (h.activeId !== id) return { ...h, runs }
  return { runs, activeId: (runs[i] ?? runs[i - 1])?.id ?? null }
}

/** Removes every unpinned run, the active one included. */
export function clearUnpinned(h: SqlHistory): SqlHistory {
  const runs = h.runs.filter((r) => r.pinned)
  if (runs.length === h.runs.length) return h
  const keepsActive = runs.some((r) => r.id === h.activeId)
  return { runs, activeId: keepsActive ? h.activeId : (runs[runs.length - 1]?.id ?? null) }
}

const SNIPPET_CHARS = 24

/** First line-ish of the SQL, whitespace collapsed, for a tab label. */
export function sqlSnippet(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim()
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat
}

/** The faint figure after the snippet: rows of the first set, or "error". */
export function runCount(run: SqlRunEntry): string {
  if (run.error !== undefined) return 'error'
  const first = run.results[0]
  if (!first) return '0'
  if (first.columns.length === 0 && first.rowsAffected != null) return `${first.rowsAffected} affected`
  return `${first.rows.length}${first.truncated ? '+' : ''}`
}

export function runTooltip(run: SqlRunEntry): string {
  const when = new Date(run.at).toLocaleTimeString()
  const head = `${when} · ${run.durationMs}ms · ${run.target}${run.pinned ? ' · pinned' : ''}`
  return `${head}\n\n${run.error !== undefined ? `${run.error}\n\n` : ''}${run.sql}`
}
