import { describe, expect, it } from 'vitest'
import { endRun, markCancelled, startRun, wasCancelled } from './sqlRunState'

describe('sql run state', () => {
  it('starts uncancelled and remembers where it runs', () => {
    expect(startRun(1, 'c1', 'shop')).toEqual({
      token: 1,
      connectionId: 'c1',
      database: 'shop',
      cancelled: false,
    })
  })

  it('marks a run cancelled once, and tolerates none', () => {
    const run = startRun(1, 'c1', 'shop')
    expect(markCancelled(run)?.cancelled).toBe(true)
    expect(markCancelled(markCancelled(run))?.cancelled).toBe(true)
    expect(markCancelled(null)).toBeNull()
  })

  it('does not let a finished run clear a newer one', () => {
    const newer = startRun(2, 'c1', 'shop')
    expect(endRun(newer, 1)).toBe(newer)
    expect(endRun(newer, 2)).toBeNull()
  })

  it('reports a cancel only for the run that was cancelled', () => {
    const run = markCancelled(startRun(3, 'c1', 'shop'))
    expect(wasCancelled(run, 3)).toBe(true)
    expect(wasCancelled(run, 2)).toBe(false)
    expect(wasCancelled(startRun(3, 'c1', 'shop'), 3)).toBe(false)
    expect(wasCancelled(null, 3)).toBe(false)
  })
})
