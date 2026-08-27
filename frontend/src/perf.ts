/**
 * Interaction timing.
 *
 * The query log answers "was the database slow" and nothing else. A 45ms query
 * followed by a 300ms React commit logs identically to a fast one, so the lag
 * you feel when clicking around is invisible from the Go side. This measures
 * the other half: what happens between the response arriving and the pixels
 * changing.
 *
 * Three sources, one sink. Two of them are the browser's own instrumentation
 * rather than anything we wrap:
 *
 * - Event Timing (`type: 'event'`) — per interaction, the time spent in our
 *   handler separately from the total to next paint. The gap between the two
 *   *is* React's render and commit, which is why there is no need to wrap
 *   components to find out whether React is the problem.
 * - Long tasks (`type: 'longtask'`) — main-thread blocks with no input
 *   attached: a timer, a resolved promise, a big parse.
 * - `span()` — explicit marks for our own code, currently the API round trips
 *   and the grid's commits. Also visible in the devtools flamechart.
 *
 * Event Timing and long tasks are Chromium-only. That covers the Windows build
 * (WebView2) and the dev server in Chrome; under WebKitGTK they stay silent and
 * the spans carry on regardless. See startup.ts for the launch-time equivalent.
 */

/** Anything at or above this is worth its own line in the log file. */
export const SLOW_MS = 200

/** Commits faster than one frame are not what anyone is feeling. */
export const SLOW_COMMIT_MS = 16

/** Per name, how many samples the percentiles are drawn from. */
const MAX_SAMPLES = 200

/** How many individual slow events are kept for the report. */
const MAX_WORST = 50

export type Sample = {
  name: string
  ms: number
  /** Free text for a single event: the handler/render split, a row count. */
  detail?: string
}

export type Row = {
  name: string
  count: number
  total: number
  p50: number
  p95: number
  max: number
  /** How many samples the percentiles used, which the cap may have limited. */
  samples: number
}

type Bucket = {
  count: number
  total: number
  max: number
  /** Ring of recent samples. Capped, so a long session cannot grow unbounded. */
  recent: number[]
  at: number
}

/**
 * Aggregates timings by name and keeps the worst individual events.
 *
 * A class rather than module state so the tests get a fresh one each time, and
 * so nothing has to be reset between them.
 */
export class PerfLog {
  private buckets = new Map<string, Bucket>()
  private worstEvents: Sample[] = []
  /** Slow events not yet written to the log file. */
  private notable: Sample[] = []
  private total = 0

  record(s: Sample) {
    this.total++
    const ms = Math.round(s.ms)
    const sample: Sample = { ...s, ms }

    let b = this.buckets.get(s.name)
    if (!b) {
      b = { count: 0, total: 0, max: 0, recent: [], at: 0 }
      this.buckets.set(s.name, b)
    }
    // count, total and max are unbounded and always true; only the sample ring
    // is capped, so the cap can never make the aggregate lie.
    b.count++
    b.total += ms
    if (ms > b.max) b.max = ms
    if (b.recent.length < MAX_SAMPLES) b.recent.push(ms)
    else {
      b.recent[b.at] = ms
      b.at = (b.at + 1) % MAX_SAMPLES
    }

    this.keepIfWorst(sample)
    if (ms >= SLOW_MS) this.notable.push(sample)
  }

  /**
   * Keeps the sample only if it belongs in the worst list.
   *
   * The early return matters: this runs on every measurement, and a sort per
   * sample would make the instrumentation part of what it is measuring. Once
   * the list is full, a sample that cannot beat the tail costs one comparison.
   */
  private keepIfWorst(s: Sample) {
    const full = this.worstEvents.length >= MAX_WORST
    if (full && s.ms <= this.worstEvents[this.worstEvents.length - 1].ms) return

    if (full) this.worstEvents[this.worstEvents.length - 1] = s
    else this.worstEvents.push(s)
    this.worstEvents.sort((a, b) => b.ms - a.ms)
  }

  /**
   * One row per name, ordered by total time spent.
   *
   * Total rather than max: forty 20ms renders are the lag and a single 300ms
   * connect is not, so the thing actually worth optimising has to sort first.
   */
  summary(): Row[] {
    const rows: Row[] = []
    for (const [name, b] of this.buckets) {
      const sorted = [...b.recent].sort((x, y) => x - y)
      rows.push({
        name,
        count: b.count,
        total: b.total,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: b.max,
        samples: sorted.length,
      })
    }
    return rows.sort((a, b) => b.total - a.total)
  }

  /** The slowest individual events, worst first. */
  worst(n: number): Sample[] {
    return this.worstEvents.slice(0, n)
  }

  /** Slow events not yet logged, handed over exactly once. */
  drainNotable(): Sample[] {
    const out = this.notable
    this.notable = []
    return out
  }

  /** Total measurements taken, so a flush can tell an idle app from a busy one. */
  get recorded(): number {
    return this.total
  }

  /** The palette command's readout, and what gets flushed to the log file. */
  reportText(): string {
    const rows = this.summary()
    if (rows.length === 0) return 'no measurements recorded'
    return rows
      .map(
        (r) =>
          `${r.name} ×${r.count} p50=${r.p50}ms p95=${r.p95}ms max=${r.max}ms total=${r.total}ms`,
      )
      .join(' · ')
  }
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[i]
}

/** The process-wide log. One app, one set of numbers. */
export const perf = new PerfLog()

/**
 * Times a promise and records it under `name`.
 *
 * Also emits a User Timing measure, so the same span shows up in the devtools
 * flamechart without being instrumented twice.
 */
export async function span<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now()
  try {
    return await fn()
  } finally {
    const ms = performance.now() - start
    perf.record({ name, ms })
    try {
      performance.measure(name, { start, duration: ms })
    } catch {
      // measure() is a nicety for devtools; a browser that rejects the
      // options form must not break the thing being measured.
    }
  }
}

/**
 * React Profiler sink. Records commits slower than a frame.
 *
 * `phase` is kept because it is the difference between a diagnosis and a
 * guess: a slow "mount" means the component is being thrown away and rebuilt
 * when it should have been updated, which is a different fix entirely from a
 * slow "update".
 */
export function onCommit(id: string, phase: string, actualDuration: number) {
  if (actualDuration < SLOW_COMMIT_MS) return
  perf.record({ name: `${id} ${phase}`, ms: actualDuration })
}

/**
 * Subscribes to the browser's interaction and long-task instrumentation.
 *
 * Safe to call once at startup on any browser: an unsupported entry type throws
 * from observe(), which is caught per observer so that the supported ones still
 * run.
 */
export function installObservers() {
  // durationThreshold is in ms and floors at 16 in Chromium. 40 keeps the
  // observer off the fast path — a responsive click is never reported.
  observe({ type: 'event', buffered: true, durationThreshold: 40 }, (list) => {
    for (const e of list.getEntries() as PerformanceEventTiming[]) {
      // processingStart→processingEnd is our handler. The rest of duration is
      // waiting to be dispatched plus React's render, commit and paint —
      // which is the split that says whose fault the lag is.
      const handler = Math.round(e.processingEnd - e.processingStart)
      const delay = Math.round(e.processingStart - e.startTime)
      const rest = Math.round(e.duration - handler - delay)
      perf.record({
        name: `event ${e.name}`,
        ms: e.duration,
        detail: `delay ${delay}ms, handler ${handler}ms, render+paint ${rest}ms`,
      })
    }
  })

  observe({ type: 'longtask', buffered: true }, (list) => {
    for (const e of list.getEntries()) {
      perf.record({ name: 'long task', ms: e.duration, detail: e.name })
    }
  })
}

/**
 * `durationThreshold` is part of Event Timing but not of this TypeScript
 * release's PerformanceObserverInit, so it is declared here rather than
 * dropped — the browser reads it whatever the types say.
 */
type ObserveOptions = PerformanceObserverInit & { durationThreshold?: number }

function observe(options: ObserveOptions, onList: (list: PerformanceObserverEntryList) => void) {
  if (typeof PerformanceObserver === 'undefined') return
  try {
    new PerformanceObserver(onList).observe(options)
  } catch {
    // WebKitGTK supports neither entry type. Losing the observer is expected
    // there and must not take the app's startup with it.
  }
}

/** How often the aggregate is written to the log file. */
const FLUSH_MS = 30_000

/**
 * Starts writing measurements to `sink`, which is the Go log file.
 *
 * Two kinds of line. Anything at or above SLOW_MS gets its own, with the
 * handler/render breakdown intact, because a single 400ms click is the thing
 * worth chasing and an average would hide it. Everything else is covered by a
 * periodic aggregate.
 *
 * Nothing is written while the app sits idle — an unattended app should not
 * fill the log — and the pending lines are flushed when the window is hidden,
 * which is the last chance before it is closed.
 *
 * Returns a function that stops the flushing.
 */
export function startFlushing(sink: (line: string) => void, log: PerfLog = perf) {
  let lastRecorded = 0

  const flush = () => {
    for (const e of log.drainNotable()) {
      sink(`perf slow ${e.name} ${e.ms}ms${e.detail ? ` (${e.detail})` : ''}`)
    }
    if (log.recorded === lastRecorded) return
    lastRecorded = log.recorded
    sink(`perf ${log.reportText()}`)
  }

  const timer = setInterval(flush, FLUSH_MS)
  const onHidden = () => {
    if (document.visibilityState === 'hidden') flush()
  }
  document.addEventListener('visibilitychange', onHidden)

  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onHidden)
  }
}
