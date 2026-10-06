import { describe, expect, it } from 'vitest'
import {
  MAX_RETAINED_CELLS,
  MAX_UNPINNED_RUNS,
  activeRun,
  addRun,
  clearUnpinned,
  closeRun,
  emptyHistory,
  nextRunId,
  runCount,
  selectRun,
  sqlSnippet,
  stepTarget,
  togglePin,
  type SqlHistory,
  type SqlRunEntry,
} from './sqlHistory'
import type { ResultSet } from './types'

function set(rows: number, cols = 1): ResultSet {
  return {
    columns: Array.from({ length: cols }, (_, i) => ({
      name: `c${i}`,
      dbType: 'int',
    })) as unknown as ResultSet['columns'],
    rows: Array(rows).fill(Array(cols).fill(1)) as ResultSet['rows'],
    truncated: false,
    textCap: 0,
    truncatedCells: [],
    elapsedMs: 1,
    query: '',
  }
}

function run(id: number, rows = 1, extra: Partial<SqlRunEntry> = {}): SqlRunEntry {
  return {
    id,
    sql: `select ${id}`,
    at: 0,
    durationMs: 1,
    target: 't',
    results: [set(rows)],
    moreResults: false,
    pinned: false,
    ...extra,
  }
}

const ids = (h: SqlHistory) => h.runs.map((r) => r.id)

function fill(n: number): SqlHistory {
  let h = emptyHistory
  for (let i = 1; i <= n; i++) h = addRun(h, run(i))
  return h
}

describe('sql history', () => {
  it('appends a run and makes it active', () => {
    const h = fill(2)
    expect(ids(h)).toEqual([1, 2])
    expect(activeRun(h)?.id).toBe(2)
    expect(nextRunId(h)).toBe(3)
  })

  it('keeps at most the unpinned limit, oldest first', () => {
    const h = fill(MAX_UNPINNED_RUNS + 3)
    expect(h.runs).toHaveLength(MAX_UNPINNED_RUNS)
    expect(ids(h)[0]).toBe(4)
  })

  it('never evicts a pinned run, and pinned runs do not count toward the limit', () => {
    let h = addRun(emptyHistory, run(1, 1, { pinned: true }))
    for (let i = 2; i <= MAX_UNPINNED_RUNS + 5; i++) h = addRun(h, run(i))
    expect(ids(h)).toContain(1)
    expect(h.runs.filter((r) => !r.pinned)).toHaveLength(MAX_UNPINNED_RUNS)
  })

  it('evicts oldest unpinned runs when the cell budget is exceeded', () => {
    const big = MAX_RETAINED_CELLS * 0.6
    let h = addRun(emptyHistory, run(1, big))
    h = addRun(h, run(2, big))
    expect(ids(h)).toEqual([2])
  })

  it('keeps the newest run even when it alone is over budget', () => {
    const h = addRun(addRun(emptyHistory, run(1)), run(2, MAX_RETAINED_CELLS + 5))
    expect(ids(h)).toEqual([2])
  })

  it('does not evict the active run when an older one is selected', () => {
    let h = addRun(emptyHistory, run(1, MAX_RETAINED_CELLS))
    h = addRun(h, run(2, 10))
    h = selectRun(h, 2)
    expect(ids(h)).toEqual([2])
  })

  it('counts pinned cells toward the budget but never drops them', () => {
    let h = addRun(emptyHistory, run(1, MAX_RETAINED_CELLS, { pinned: true }))
    h = addRun(h, run(2, 10))
    expect(ids(h)).toEqual([1, 2])
  })

  it('evicts after an unpin pushes the history over a limit', () => {
    let h = addRun(emptyHistory, run(1, 1, { pinned: true }))
    for (let i = 2; i <= MAX_UNPINNED_RUNS + 1; i++) h = addRun(h, run(i))
    expect(h.runs).toHaveLength(MAX_UNPINNED_RUNS + 1)
    h = togglePin(h, 1)
    expect(ids(h)).not.toContain(1)
  })

  it('closing the active run activates the next, else the previous', () => {
    let h = selectRun(fill(3), 2)
    expect(closeRun(h, 2).activeId).toBe(3)
    h = selectRun(fill(3), 3)
    expect(closeRun(h, 3).activeId).toBe(2)
    expect(closeRun(fill(1), 1)).toEqual({ runs: [], activeId: null })
  })

  it('closing another run leaves the active one', () => {
    const h = closeRun(fill(3), 1)
    expect(ids(h)).toEqual([2, 3])
    expect(h.activeId).toBe(3)
  })

  it('clear removes unpinned runs only and falls back to a pinned one', () => {
    let h = fill(3)
    h = togglePin(h, 1)
    const c = clearUnpinned(h)
    expect(ids(c)).toEqual([1])
    expect(c.activeId).toBe(1)
    expect(clearUnpinned(clearUnpinned(fill(2)))).toEqual(emptyHistory)
  })

  it('steps with wrap and has nowhere to go with fewer than two runs', () => {
    const h = fill(3)
    expect(stepTarget(h, 1)).toBe(1)
    expect(stepTarget(h, -1)).toBe(2)
    expect(stepTarget(fill(1), 1)).toBeNull()
    expect(stepTarget(emptyHistory, -1)).toBeNull()
  })

  it('ignores selecting a run that is gone', () => {
    const h = fill(2)
    expect(selectRun(h, 99)).toBe(h)
  })

  it('labels: snippet collapses whitespace and truncates', () => {
    expect(sqlSnippet('select  *\n  from   t')).toBe('select * from t')
    expect(sqlSnippet('select aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(`select ${'a'.repeat(17)}…`)
    expect(runCount(run(1, 5))).toBe('5')
    expect(runCount(run(1, 0, { results: [], error: 'boom' }))).toBe('error')
  })
})
