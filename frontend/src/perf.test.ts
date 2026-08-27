import { beforeEach, describe, expect, it } from 'vitest'
import { PerfLog, SLOW_MS } from './perf'

describe('PerfLog', () => {
  let perf: PerfLog

  beforeEach(() => {
    perf = new PerfLog()
  })

  it('aggregates repeated samples of one name', () => {
    perf.record({ name: 'api ReadRows', ms: 10 })
    perf.record({ name: 'api ReadRows', ms: 30 })
    perf.record({ name: 'api ReadRows', ms: 20 })

    const [row] = perf.summary()
    expect(row.name).toBe('api ReadRows')
    expect(row.count).toBe(3)
    expect(row.max).toBe(30)
    expect(row.total).toBe(60)
  })

  it('keeps names apart', () => {
    perf.record({ name: 'a', ms: 5 })
    perf.record({ name: 'b', ms: 5 })
    expect(perf.summary()).toHaveLength(2)
  })

  /**
   * Ordered by total time, not by the worst single sample: forty 20ms renders
   * are the lag, and a single 300ms connect is not, so the thing to optimise
   * has to come first.
   */
  it('orders the summary by total time spent', () => {
    perf.record({ name: 'one slow thing', ms: 300 })
    for (let i = 0; i < 40; i++) perf.record({ name: 'death by a thousand cuts', ms: 20 })

    expect(perf.summary()[0].name).toBe('death by a thousand cuts')
  })

  it('reports p50 and p95 from the samples it kept', () => {
    for (let i = 1; i <= 100; i++) perf.record({ name: 'x', ms: i })

    const [row] = perf.summary()
    expect(row.p50).toBe(50)
    expect(row.p95).toBe(95)
  })

  it('survives a single sample', () => {
    perf.record({ name: 'x', ms: 7 })
    const [row] = perf.summary()
    expect(row.p50).toBe(7)
    expect(row.p95).toBe(7)
    expect(row.max).toBe(7)
  })

  /**
   * The counts and totals must stay true over a long session, so the cap
   * applies to the retained samples the percentiles are drawn from, never to
   * count/total/max.
   */
  it('caps retained samples without losing the count or the max', () => {
    for (let i = 0; i < 500; i++) perf.record({ name: 'x', ms: 1 })
    perf.record({ name: 'x', ms: 999 })
    for (let i = 0; i < 500; i++) perf.record({ name: 'x', ms: 1 })

    const [row] = perf.summary()
    expect(row.count).toBe(1001)
    expect(row.max).toBe(999)
    expect(row.samples).toBeLessThanOrEqual(200)
  })

  it('lists the slowest individual events, worst first', () => {
    perf.record({ name: 'a', ms: 10 })
    perf.record({ name: 'b', ms: 400 })
    perf.record({ name: 'c', ms: 50 })

    expect(perf.worst(2).map((e) => e.name)).toEqual(['b', 'c'])
  })

  it('keeps the detail attached to a slow event', () => {
    perf.record({ name: 'click', ms: 250, detail: 'handler 12ms, render 238ms' })
    expect(perf.worst(1)[0].detail).toBe('handler 12ms, render 238ms')
  })

  /** The worst list is bounded too, or a long session grows without limit. */
  it('bounds the worst list', () => {
    for (let i = 1; i <= 200; i++) perf.record({ name: `e${i}`, ms: i })

    const worst = perf.worst(1000)
    expect(worst.length).toBeLessThanOrEqual(50)
    expect(worst[0].ms).toBe(200)
  })

  it('reports nothing before anything is recorded', () => {
    expect(perf.summary()).toEqual([])
    expect(perf.worst(10)).toEqual([])
    expect(perf.reportText()).toBe('no measurements recorded')
  })

  it('renders a one-line report per row', () => {
    perf.record({ name: 'api ReadRows', ms: 40 })
    const text = perf.reportText()
    expect(text).toContain('api ReadRows')
    expect(text).toContain('40')
  })

  /**
   * Only what crossed the threshold is worth a line in the log file. Below it,
   * the aggregate is the whole story.
   */
  it('treats anything at or above the slow threshold as notable', () => {
    perf.record({ name: 'fast', ms: SLOW_MS - 1 })
    perf.record({ name: 'slow', ms: SLOW_MS })

    expect(perf.drainNotable().map((e) => e.name)).toEqual(['slow'])
  })

  it('drains notable events once', () => {
    perf.record({ name: 'slow', ms: SLOW_MS + 100 })
    expect(perf.drainNotable()).toHaveLength(1)
    expect(perf.drainNotable()).toHaveLength(0)
  })

  it('rounds fractional milliseconds, which the browser reports', () => {
    perf.record({ name: 'x', ms: 12.678 })
    expect(perf.worst(1)[0].ms).toBe(13)
  })
})
