/**
 * Crash reporting.
 *
 * A throw during render used to unmount the whole tree to a white page: no
 * message on screen, and — because nothing caught it — no line in the log
 * either, so `ja-db.log` held only the startup entries and the crash left no
 * trace at all. This is the pure half of the fix; `components/Boundary.tsx`
 * is the surface that shows it.
 *
 * Kept out of the component so it can be tested without a DOM, as with the
 * rest of the logic modules here.
 */

import { errorMessage } from './errors'

/** What is known about a crash, whatever was actually thrown. */
export interface CrashDetail {
  /** Where it came from — 'render', 'unhandled error', 'unhandled rejection'. */
  source: string
  message: string
  /** '' when the thrown value carried no stack, which a thrown string does not. */
  stack: string
  /** React's own component stack, when the boundary supplied one. */
  componentStack: string
}

export function crashDetail(e: unknown, source: string, componentStack = ''): CrashDetail {
  return {
    source,
    message: errorMessage(e),
    stack: e instanceof Error ? (e.stack ?? '') : '',
    componentStack,
  }
}

/**
 * One log line for a crash.
 *
 * Folded onto a single line because the Go logger writes one timestamped line
 * per call, and a raw multi-line stack would break that into entries with no
 * date on them.
 */
export function crashLogLine(d: CrashDetail): string {
  const head = `crash [${d.source}] ${d.message}`
  const trace = [d.stack, d.componentStack]
    .filter((s) => s.trim() !== '')
    .join('\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join(' · ')
  return trace === '' ? head : `${head} — ${trace}`
}
