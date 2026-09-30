/**
 * Arithmetic behind the activity tray.
 *
 * `elapsedMs` on a QueryInfo is a measurement Go took while answering the
 * poll, not something the browser can recompute: `startedAt` is the server's
 * wall clock and drifting clocks would make a fresh query read as ten seconds
 * old. So the tray takes the server's number and adds the time since that
 * answer arrived, which lets the timers tick between polls without polling
 * faster.
 */

import type { QueryInfo, QueryPhase } from './types'

/** Phases that mean the query has stopped. Mirrors Phase.Terminal in Go. */
const TERMINAL: readonly QueryPhase[] = ['done', 'failed', 'cancelled']

export function isRunning(q: QueryInfo): boolean {
  return !TERMINAL.includes(q.phase)
}

/**
 * Elapsed time to show for one query, extrapolated to `now` while it runs.
 * A finished query keeps the duration it finished with — history must not
 * appear to still be counting.
 */
export function elapsedFor(q: QueryInfo, polledAt: number, now: number): number {
  if (!isRunning(q)) return q.elapsedMs
  // Clamp: a clock that jumps backwards must not make a timer count down.
  return q.elapsedMs + Math.max(0, now - polledAt)
}

/**
 * The freshly polled list, with every entry that has not changed since the last
 * poll swapped for the object the tray already holds. A poll answers with new
 * objects for all 500 entries every 700ms; giving the memoised rows back the
 * references they had is what lets a finished row skip rendering. Returns
 * `prev` itself when nothing at all differs.
 */
export function reuseUnchanged(prev: QueryInfo[], next: QueryInfo[]): QueryInfo[] {
  const before = new Map(prev.map((q) => [q.id, q]))
  let same = prev.length === next.length
  const out = next.map((q, i) => {
    const old = before.get(q.id)
    const keep = old && shallowEqual(old, q) ? old : q
    if (keep !== prev[i]) same = false
    return keep
  })
  return same ? prev : out
}

function shallowEqual(a: QueryInfo, b: QueryInfo): boolean {
  const ak = Object.keys(a) as (keyof QueryInfo)[]
  return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k])
}

/*
 * There is deliberately no filter here. Catalogue reads were first dropped,
 * then kept but hidden from the view by default; both left a log that could not
 * be trusted ("I can see it running, it never appears"). The tray now shows
 * everything the app executed, in the order Go reports it.
 */

/** What the collapsed strip has to say without expanding anything. */
export interface TrayStatus {
  running: number
  /** Asked to stop but not yet unwound — shown separately so the strip does
   *  not look stuck while a cancel propagates to the driver. */
  cancelling: number
  /** Age of the oldest running query, which is the number people watch. */
  longestMs: number
  /** Finished queries retained in the log. */
  finished: number
}

export function trayStatus(queries: QueryInfo[], polledAt: number, now: number): TrayStatus {
  let running = 0
  let cancelling = 0
  let longestMs = 0
  let finished = 0
  for (const q of queries) {
    if (!isRunning(q)) {
      finished++
      continue
    }
    running++
    if (q.phase === 'cancelling') cancelling++
    longestMs = Math.max(longestMs, elapsedFor(q, polledAt, now))
  }
  return { running, cancelling, longestMs, finished }
}
