import { describe, expect, it } from 'vitest'
import { elapsedFor, isRunning, reuseUnchanged, trayStatus } from './activity'
import type { QueryInfo } from './types'

function query(over: Partial<QueryInfo> = {}): QueryInfo {
  return {
    id: 'q001',
    connectionId: 'c1',
    database: 'shop',
    kind: 'browse',
    sql: 'select * from orders',
    // Deliberately far from the browser's clock: nothing may read it.
    startedAt: '1999-01-01T00:00:00Z',
    elapsedMs: 250,
    phase: 'reading rows',
    rowsRead: 0,
    ...over,
  }
}

describe('isRunning', () => {
  it('treats the three terminal phases as finished', () => {
    expect(isRunning(query({ phase: 'queued' }))).toBe(true)
    expect(isRunning(query({ phase: 'cancelling' }))).toBe(true)
    expect(isRunning(query({ phase: 'done' }))).toBe(false)
    expect(isRunning(query({ phase: 'failed' }))).toBe(false)
    expect(isRunning(query({ phase: 'cancelled' }))).toBe(false)
  })
})

describe('elapsedFor', () => {
  it('adds the time since the poll to the number Go measured', () => {
    expect(elapsedFor(query(), 1000, 1400)).toBe(650)
  })

  it('ignores the server wall clock entirely', () => {
    // Same inputs, a startedAt from a decade away: same answer.
    const skewed = query({ startedAt: '2040-06-01T12:00:00Z' })
    expect(elapsedFor(skewed, 1000, 1400)).toBe(650)
  })

  it('never counts backwards when the clock jumps back', () => {
    expect(elapsedFor(query(), 5000, 4000)).toBe(250)
  })

  it('freezes the duration of a finished query', () => {
    const done = query({ phase: 'done', elapsedMs: 812 })
    expect(elapsedFor(done, 1000, 99_000)).toBe(812)
  })
})

describe('trayStatus', () => {
  it('is empty when nothing has run', () => {
    expect(trayStatus([], 1000, 2000)).toEqual({
      running: 0,
      cancelling: 0,
      longestMs: 0,
      finished: 0,
    })
  })

  it('reports the oldest running query, not the newest', () => {
    const s = trayStatus(
      [query({ id: 'q002', elapsedMs: 40 }), query({ id: 'q001', elapsedMs: 9000 })],
      1000,
      1100,
    )
    expect(s.running).toBe(2)
    expect(s.longestMs).toBe(9100)
  })

  it('counts queries that are cancelling', () => {
    const s = trayStatus([query({ phase: 'cancelling' }), query({ id: 'q002' })], 0, 0)
    expect(s).toEqual({ running: 2, cancelling: 1, longestMs: 250, finished: 0 })
  })

  it('separates history from what is running, and does not age history', () => {
    const s = trayStatus(
      [query({ elapsedMs: 100 }), query({ id: 'q002', phase: 'done', elapsedMs: 60_000 })],
      1000,
      1500,
    )
    expect(s).toEqual({ running: 1, cancelling: 0, longestMs: 600, finished: 1 })
  })
})

describe('reuseUnchanged', () => {
  it('hands back the existing object for an entry that has not changed', () => {
    const old = query({ id: 'q001', phase: 'done' })
    const out = reuseUnchanged([old], [{ ...old }])
    expect(out[0]).toBe(old)
  })

  it('returns the previous array when nothing differs', () => {
    const prev = [query({ phase: 'done' })]
    expect(
      reuseUnchanged(
        prev,
        prev.map((q) => ({ ...q })),
      ),
    ).toBe(prev)
  })

  it('takes the new object for an entry that moved on, and keeps the rest', () => {
    const done = query({ id: 'q001', phase: 'done' })
    const running = query({ id: 'q002', elapsedMs: 10 })
    const next = [{ ...running, elapsedMs: 710 }, { ...done }]
    const out = reuseUnchanged([running, done], next)
    expect(out[0]).toBe(next[0])
    expect(out[1]).toBe(done)
  })

  it('passes a new entry through', () => {
    const out = reuseUnchanged([], [query()])
    expect(out).toHaveLength(1)
  })
})
