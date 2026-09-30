import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { transportName } from '../api'
import { LIMITS, Resizer, useResizable } from './Resizer'
import { elapsedFor, isRunning, trayStatus } from '../activity'
import { formatCount, formatDuration } from '../commands'
import { useStore } from '../store'
import { Dialog, dialogButton } from '../ui'
import type { QueryInfo, QueryKind, QueryPhase } from '../types'

/** How often Go is asked what is running — only while something is. */
const POLL_MS = 700
/** How often the on-screen timers advance. Local arithmetic, no request. */
const TICK_MS = 100
/** Rows drawn before "Show older"; the log keeps far more than anyone reads. */
const VISIBLE_ROWS = 100

const KIND_LABEL: Record<QueryKind, string> = {
  browse: 'browse',
  count: 'count',
  query: 'editor',
  introspect: 'catalogue',
  ddl: 'schema',
  write: 'rows',
}

/**
 * Status colours. Only three distinctions matter at a glance: waiting on the
 * server, working locally, and something the user should look at.
 */
const PHASE_CLASS: Record<QueryPhase, string> = {
  queued: 'text-[var(--color-faint)]',
  executing: 'text-[var(--color-accent)]',
  'reading rows': 'text-[var(--color-success)]',
  cancelling: 'text-[var(--color-warn)]',
  done: 'text-[var(--color-faint)]',
  failed: 'text-[var(--color-danger)]',
  cancelled: 'text-[var(--color-warn)]',
}

/**
 * The bottom tray: always present, collapsed to one strip, expandable to the
 * query log — what is running now, above a bounded history of what has just
 * run, with a cancel on anything still going.
 *
 * It never opens itself. A query starting is announced by the strip's
 * indeterminate bar; taking over the bottom of the window uninvited, every
 * time a page is turned, would be worse than the problem it solves.
 *
 * The tray is also the app's only activity poller. It is mounted for the whole
 * session, so putting the polling here means one interval rather than one per
 * interested component — the connections page reads the same snapshot.
 *
 * The strip's height never changes with what is running. A query starting must
 * not resize the grid underneath it, so the expanded list is an overlay rather
 * than another row in the layout.
 */
export function ActivityTray() {
  const queries = useStore((s) => s.activity.queries)
  const polledAt = useStore((s) => s.activityPolledAt)
  const inFlight = useStore((s) => s.inFlight)
  const open = useStore((s) => s.trayOpen)
  const setTrayOpen = useStore((s) => s.setTrayOpen)
  const refresh = useStore((s) => s.refreshActivity)
  const clearHistory = useStore((s) => s.clearQueryHistory)
  const connections = useStore((s) => s.connections)
  const [showAll, setShowAll] = useState(false)

  const resize = useResizable('trayHeightPx', LIMITS.tray)

  // The app is the only thing that issues queries, so its own count of
  // outstanding calls is the whole answer to "is there anything to watch".
  // With history retained the list is otherwise static: an open tray over an
  // idle app has nothing to re-fetch, and polling it would be a request per
  // second forever for a list that cannot change.
  usePolling(inFlight > 0, refresh)
  const now = useTicker(queries.some(isRunning))
  const status = trayStatus(queries, polledAt, now)
  // Looked up once here so a row does not subscribe to the whole connection list.
  const names = useMemo(() => new Map(connections.map((c) => [c.id, c.name])), [connections])
  const shown = showAll ? queries : queries.slice(0, VISIBLE_ROWS)

  const label =
    status.running === 0
      ? status.finished > 0
        ? `Idle · ${status.finished} in the log`
        : 'Nothing running'
      : `${status.running} running · ${formatDuration(status.longestMs)}` +
        (status.cancelling > 0 ? ` · ${status.cancelling} cancelling` : '')

  return (
    <div className="chrome relative shrink-0 border-t border-[var(--color-border)] bg-[var(--color-panel)]">
      {open && (
        <div
          // Height is inline because it is dragged. Capped by the viewport as
          // well as by the setting: a height saved on a large monitor must not
          // bury the grid on a small one.
          style={{ height: `min(${resize.size}px, 80vh)` }}
          // z-30: above the grid's sticky headers (z-20), below dialogs (z-40).
          className="absolute inset-x-0 bottom-full z-30 flex flex-col border-t border-[var(--color-border)] bg-[var(--color-panel)] shadow-[0_-10px_30px_rgb(var(--color-shadow)/0.16)]"
        >
          {/* Dragging the top edge upwards makes the tray taller, hence invert. */}
          <Resizer {...resize} axis="y" invert label="Resize the activity tray" className="top-0" />
          {/* Column widths are repeated in QueryRow. Fixed rather than a grid
              so a row appearing cannot shift the columns of the rest. */}
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3 py-1 tracking-wider text-[var(--color-faint)] uppercase">
            <span className="w-12 shrink-0">ID</span>
            <span className="w-16 shrink-0">Kind</span>
            <span className="w-32 shrink-0">Status</span>
            <span className="w-24 shrink-0">Where</span>
            <span className="min-w-0 flex-1">Query</span>
            <span className="w-14 shrink-0" />
            <span className="w-14 shrink-0 text-right">Time</span>
            <button
              onClick={() => void clearHistory()}
              disabled={status.finished === 0}
              className="w-16 shrink-0 rounded-full py-0.5 tracking-normal normal-case disabled:opacity-30 enabled:hover:bg-[var(--color-elevated)] enabled:hover:text-[var(--color-text)]"
            >
              Clear log
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {queries.length === 0 ? (
              <p className="px-3 py-4 text-center text-[var(--color-faint)]">No queries yet</p>
            ) : (
              <ul className="flex flex-col">
                {shown.map((q) => {
                  // Only a running row's timer moves. Handing the clock to
                  // finished rows would re-render all of them every tick.
                  const running = isRunning(q)
                  return (
                    <QueryRow
                      key={q.id}
                      query={q}
                      name={names.get(q.connectionId) ?? q.connectionId}
                      polledAt={running ? polledAt : 0}
                      now={running ? now : 0}
                    />
                  )
                })}
              </ul>
            )}
            {shown.length < queries.length && (
              <button
                onClick={() => setShowAll(true)}
                className="w-full border-t border-[var(--color-border)] py-1.5 text-center text-[var(--color-faint)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)]"
              >
                Show {queries.length - shown.length} older
              </button>
            )}
          </div>
        </div>
      )}

      {/* The strip is one button so the whole width is a hit target. */}
      <button
        onClick={() => setTrayOpen(!open)}
        aria-expanded={open}
        title="Query activity (Ctrl+`)"
        className="flex h-6 w-full items-center gap-2 px-3 hover:bg-[var(--color-elevated)]"
      >
        <span className="text-[var(--color-faint)]">{open ? '▾' : '▸'}</span>
        <span className="font-semibold tracking-wider text-[var(--color-faint)] uppercase">
          Activity
        </span>
        <span
          className={status.running > 0 ? 'text-[var(--color-text)]' : 'text-[var(--color-faint)]'}
        >
          {label}
        </span>
        {status.running > 0 && <IndeterminateBar className="ml-1 h-[3px] w-24 rounded-full" />}
        {/* Only says anything in the browser transport, where knowing you are
            not in the real app is worth a few pixels. */}
        {transportName === 'http' && (
          <span className="ml-auto text-[var(--color-warn)]">dev (browser)</span>
        )}
        <span
          className={`font-[var(--font-mono)] text-[var(--color-faint)] ${
            transportName === 'http' ? 'ml-3' : 'ml-auto'
          }`}
        >
          Ctrl+`
        </span>
      </button>
    </div>
  )
}

/**
 * Memoised: the list can hold hundreds of rows and the clock ticks ten times a
 * second while anything runs. Every prop is a primitive or an object the store
 * keeps stable for a finished query, so only the running rows re-render.
 */
const QueryRow = memo(function QueryRow({
  query,
  name,
  polledAt,
  now,
}: {
  query: QueryInfo
  name: string
  polledAt: number
  now: number
}) {
  const cancelQuery = useStore((s) => s.cancelQuery)
  const setDialog = useStore((s) => s.setDialog)
  const confirmDestructive = useStore((s) => s.settings.confirmDestructive)
  const copyText = useStore((s) => s.copyText)
  const pushToast = useStore((s) => s.pushToast)

  const running = isRunning(query)
  const elapsed = elapsedFor(query, polledAt, now)

  // Go caps the SQL it retains per history entry, so for a very long statement
  // this copies what was kept rather than the original. Saying so beats a
  // silent partial copy.
  const copySql = async () => {
    await copyText(query.sql)
    if (query.sql.endsWith('…')) {
      pushToast('info', `Copied ${query.id}, trimmed to the length the log keeps`)
    } else {
      pushToast('info', `Copied the statement for ${query.id}`)
    }
  }

  const requestCancel = () => {
    if (confirmDestructive) setDialog({ kind: 'confirmCancel', queryId: query.id, sql: query.sql })
    else void cancelQuery(query.id)
  }

  return (
    <li
      className={`flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-1 last:border-b-0 ${
        running ? '' : 'text-[var(--color-faint)]'
      }`}
    >
      <span className="w-12 shrink-0 font-[var(--font-mono)] text-[var(--color-muted)]">
        {query.id}
      </span>
      <span className="w-16 shrink-0 truncate">{KIND_LABEL[query.kind] ?? query.kind}</span>
      <span className={`flex w-32 shrink-0 items-center gap-1.5 ${PHASE_CLASS[query.phase]}`}>
        <span className="truncate uppercase">{query.phase}</span>
        {/* Rows read is the honest version of "we are scanning": it moves. */}
        {query.rowsRead > 0 && (
          <span className="font-[var(--font-mono)] text-[var(--color-faint)]">
            {formatCount(query.rowsRead)}
          </span>
        )}
      </span>
      <span
        className="w-24 shrink-0 truncate text-[var(--color-faint)]"
        title={query.database ? `${name} / ${query.database}` : name}
      >
        {name}
      </span>
      {/* One line here: the tray is a glance, and rendering a megabyte
          statement into a row nobody is reading would cost the scroll
          performance the tray is meant to have. Clicking copies the whole
          statement instead — the text is already in the snapshot, it is only
          the *rendering* that is trimmed. */}
      <button
        onClick={() => void copySql()}
        title={
          (query.error ? `${query.sql}\n\n${query.error}\n\n` : `${query.sql}\n\n`) +
          'Click to copy the statement'
        }
        className={`min-w-0 flex-1 truncate text-left font-[var(--font-mono)] hover:underline ${
          query.error ? 'text-[var(--color-danger)]' : ''
        }`}
      >
        {query.error ?? query.sql}
      </button>
      {running ? (
        <IndeterminateBar
          className="h-[3px] w-14 shrink-0 rounded-full"
          warn={query.phase === 'cancelling'}
        />
      ) : (
        <span className="w-14 shrink-0" />
      )}
      <span
        className={`w-14 shrink-0 text-right font-[var(--font-mono)] ${
          running && elapsed > 5000 ? 'text-[var(--color-warn)]' : ''
        }`}
      >
        {formatDuration(elapsed)}
      </span>
      <button
        onClick={requestCancel}
        disabled={!running || query.phase === 'cancelling'}
        className="w-16 shrink-0 rounded-lg border border-[var(--color-border-strong)] py-0.5 text-[var(--color-danger)] disabled:invisible enabled:hover:border-[var(--color-danger)]"
      >
        Cancel
      </button>
    </li>
  )
})

/**
 * Confirmation for cancelling. Cancelling a half-written statement is not
 * free, and the button sits in a list of rows that shift as queries finish, so
 * a mis-click is easy. Enter confirms — the button is focused on mount — and
 * Escape backs out. Turning off "confirm destructive actions" in Settings
 * removes this step for anyone who would rather have the single click.
 */
export function ConfirmCancelDialog({ queryId, sql }: { queryId: string; sql: string }) {
  const setDialog = useStore((s) => s.setDialog)
  const cancelQuery = useStore((s) => s.cancelQuery)
  const close = () => setDialog({ kind: 'none' })

  return (
    <Dialog
      open
      onClose={close}
      title={`Cancel ${queryId}?`}
      widthClass="w-[min(30rem,92vw)]"
      footer={
        <>
          <button onClick={close} className={`ml-auto ${dialogButton.ghost}`}>
            Keep running
          </button>
          <button
            autoFocus
            onClick={() => void cancelQuery(queryId)}
            className={dialogButton.dangerFilled}
          >
            Cancel query
          </button>
        </>
      }
    >
      <div className="px-4 py-4">
        <p className="mb-2 leading-relaxed text-[var(--color-muted)]">
          The statement is stopped at the server. A write that is part-way through is rolled back by
          the database, not by this app.
        </p>
        <pre className="max-h-32 overflow-auto rounded-xl bg-[var(--color-panel)] p-3 font-[var(--font-mono)] whitespace-pre-wrap text-[var(--color-muted)]">
          {sql}
        </pre>
      </div>
    </Dialog>
  )
}

/**
 * Indeterminate on purpose: a query's duration is not knowable up front, and a
 * percentage that is really a guess is worse than none. The bar shows motion,
 * the status and timer beside it show the facts.
 */
function IndeterminateBar({ className = '', warn = false }: { className?: string; warn?: boolean }) {
  return (
    <span
      role="progressbar"
      aria-label="Running"
      className={`indeterminate ${warn ? 'indeterminate-warn' : ''} ${className}`}
    />
  )
}

/** Polls while `on`, and once more on the way down so the log ends up settled. */
function usePolling(on: boolean, refresh: () => Promise<void>) {
  // Starts settled: a cold, idle app must not issue a request just to be told
  // that nothing is running.
  const settled = useRef(true)

  useEffect(() => {
    if (on || !settled.current) void refresh()
    settled.current = !on
    if (!on) return
    const t = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(t)
  }, [on, refresh])
}

/** A clock that only runs while something needs timing. */
function useTicker(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(t)
  }, [on])

  // While off, the value is stale but unused: history carries its own final
  // duration and nothing else is being timed.
  return now
}
