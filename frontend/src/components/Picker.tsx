import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { TlsTag } from './TlsTag'
import { describeConnection, formatCount, objectCandidate, OBJECT_ICON, qualifiedName } from '../commands'
import { tableKey } from '../edits'
import { rankCandidates } from '../fuzzy'
import { listMove, moveIndex } from '../listNav'
import { useStore } from '../store'
import type { ObjectType, SchemaObject } from '../types'
import { ConnectionMenu } from './ConnectionMenu'
import { Highlight } from './Highlight'
import { ObjectListMenu, objectKey } from './ObjectMenu'
import { TableMark } from './TableMark'

const GROUP_ORDER: ObjectType[] = ['table', 'view', 'function', 'procedure']
/** One pastel per object kind, so the groups are told apart at a glance. */
const GROUP_TINT: Record<ObjectType, string> = {
  table: 'var(--color-mint)',
  view: 'var(--color-sky)',
  function: 'var(--color-lemon)',
  procedure: 'var(--color-peach)',
}
const GROUP_LABEL: Record<ObjectType, string> = {
  table: 'Tables',
  view: 'Views',
  function: 'Functions',
  procedure: 'Procedures',
}

const INPUT =
  'w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-elevated)] px-2 py-1 outline-none placeholder:text-[var(--color-faint)]'
const PILL = 'rounded-lg bg-[var(--color-accent-dim)]/55'
const ICON_BUTTON =
  'relative shrink-0 rounded-full px-2 leading-6 text-[var(--color-faint)] opacity-40 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)]'

type StepId = 'connection' | 'database' | 'table'

const HEADLINE: Record<StepId, string> = {
  connection: 'Choose a connection',
  database: 'Choose a database',
  table: 'Choose a table',
}

/**
 * What a tab with nothing open shows: a three-step accordion, connection, then
 * database, then table, centred under a line saying what to do.
 *
 * Choosing in a step collapses it to a one-line summary and opens the next, so
 * the path stays readable and the part that wants attention is the only part
 * open. Any finished step can be reopened by clicking its header to redo it.
 * A server with no databases to choose between (SQLite) skips the middle step.
 *
 * Memoised and propless for the same reason the sidebar it replaced was: the
 * object list is not virtualised, and none of its cost is ever the reason a
 * parent re-rendered.
 */
export const Picker = memo(function Picker() {
  const connections = useStore((s) => s.connections)
  const connectedIds = useStore((s) => s.connectedIds)
  const activeConnectionId = useStore((s) => s.activeConnectionId)
  const capabilities = useStore((s) => s.capabilities)
  const databases = useStore((s) => s.databases)
  const activeDatabase = useStore((s) => s.activeDatabase)
  const objects = useStore((s) => s.objects)
  const busy = useStore((s) => s.busy)
  const connect = useStore((s) => s.connect)
  const selectDatabase = useStore((s) => s.selectDatabase)
  const openObject = useStore((s) => s.openObject)
  const removeConnection = useStore((s) => s.removeConnection)
  const setDialog = useStore((s) => s.setDialog)

  const [objectQuery, setObjectQuery] = useState('')
  const [dbQuery, setDbQuery] = useState('')

  const hasDatabaseStep = !!activeConnectionId && !!capabilities?.serverHostsDatabases
  const deepest: StepId = !activeConnectionId ? 'connection' : 'table'
  const [step, setStep] = useState<StepId>(deepest)

  // A connection chosen here moves on to the next step. Done on the change, not
  // on mount: coming back to the picker with a table list already loaded should
  // land on the tables, not replay the choice.
  const lastConnection = useRef(activeConnectionId)
  useEffect(() => {
    if (lastConnection.current === activeConnectionId) return
    lastConnection.current = activeConnectionId
    if (activeConnectionId) setStep(hasDatabaseStep ? 'database' : 'table')
    else setStep('connection')
  }, [activeConnectionId, hasDatabaseStep])

  // The row being connected to, so the click is acknowledged while it waits.
  const [pending, setPending] = useState<string | null>(null)
  useEffect(() => {
    if (!busy) setPending(null)
  }, [busy])

  const matched = useMemo(
    () =>
      objectQuery ? rankCandidates(objectQuery, objects, objectCandidate).map((r) => r.item) : objects,
    [objects, objectQuery],
  )
  const grouped = useMemo(() => {
    const out = new Map<ObjectType, SchemaObject[]>()
    for (const o of matched) {
      const list = out.get(o.type)
      if (list) list.push(o)
      else out.set(o.type, [o])
    }
    return out
  }, [matched])

  const visibleDatabases = useMemo(
    () =>
      dbQuery ? rankCandidates(dbQuery, databases, (d) => ({ name: d })).map((r) => r.item) : databases,
    [databases, dbQuery],
  )

  // The objects in the order they are drawn, which is the order the keys walk.
  const objectOrder = useMemo(() => GROUP_ORDER.flatMap((t) => grouped.get(t) ?? []), [grouped])
  const objectIndex = useMemo(() => new Map(objectOrder.map((o, i) => [o, i])), [objectOrder])

  // One highlight for whichever step is open; it restarts when the step or
  // its filter changes, since the list under it is a different list.
  const [selected, setSelected] = useState(0)

  const root = useRef<HTMLDivElement>(null)
  const tableFilter = useRef<HTMLInputElement>(null)
  const dbFilter = useRef<HTMLInputElement>(null)
  useEffect(() => {
    setSelected(
      step === 'connection'
        ? Math.max(0, connections.findIndex((c) => c.id === activeConnectionId))
        : step === 'database'
          ? Math.max(0, databases.indexOf(activeDatabase))
          : 0,
    )
    // After the step has started opening, so the field exists and is on screen.
    // A step with no filter field (connections, a short database list) focuses
    // the root, so the movement keys still have somewhere to land.
    const id = requestAnimationFrame(() => {
      const field = step === 'table' ? tableFilter.current : step === 'database' ? dbFilter.current : null
      ;(field ?? root.current)?.focus()
    })
    return () => cancelAnimationFrame(id)
    // Only on a step change: a refresh of the lists must not yank the highlight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  useEffect(() => {
    root.current?.querySelector('[data-highlight]')?.scrollIntoView({ block: 'nearest' })
  }, [selected, step])

  const pickConnection = (id: string) => {
    setPending(id)
    void connect(id)
  }
  const pickDatabase = (d: string) => {
    void selectDatabase(d)
    setStep('table')
  }

  // Enter takes the highlighted row, so a path is reachable without leaving the
  // keyboard: type a few letters, Enter. A focused button is left to activate
  // itself — it is what the user is looking at.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const count =
      step === 'connection' ? connections.length : step === 'database' ? visibleDatabases.length : objectOrder.length
    const move = listMove(e)
    if (move) {
      e.preventDefault()
      setSelected((i) => moveIndex(move, i, count))
      return
    }
    if (e.key !== 'Enter' || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    if (step === 'connection') {
      const c = connections[selected]
      if (c) pickConnection(c.id)
    } else if (step === 'database') {
      const d = visibleDatabases[selected]
      if (d) pickDatabase(d)
    } else {
      const o = objectOrder[selected]
      if (o) void openObject(o)
    }
  }

  const activeConnection = connections.find((c) => c.id === activeConnectionId)

  return (
    <div
      ref={root}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="chrome flex h-full min-h-0 flex-col items-center overflow-y-auto px-4 pt-[8vh] pb-8 outline-none focus-visible:outline-none"
    >
      <div className="flex w-full max-w-xl flex-col gap-5">
        <header className="text-center">
          <h1 className="font-bold text-[var(--color-text)]">{HEADLINE[step]}</h1>
          <p className="mt-1 text-[var(--color-muted)]">
            or press{' '}
            <kbd className="rounded-lg border border-[var(--color-border-strong)] px-1.5">Ctrl+P</kbd>{' '}
            to jump to a table from anywhere
          </p>
        </header>

        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-elevated)] shadow-sm">
          <Step
            n={1}
            label="Connection"
            summary={activeConnection?.name}
            colour={activeConnection?.colour}
            open={step === 'connection'}
            enabled
            onOpen={() => setStep('connection')}
          >
            <Highlight className="max-h-[min(22rem,45vh)] overflow-y-auto px-1.5 pb-1.5" pillClassName={PILL}>
              {connections.length === 0 && (
                <p className="px-2 py-3 leading-relaxed text-[var(--color-faint)]">
                  No connections yet. Add one to get started.
                </p>
              )}
              {connections.map((c, i) => {
                const active = c.id === activeConnectionId
                const connected = connectedIds.includes(c.id)
                return (
                  <ConnectionMenu key={c.id} connection={c}>
                    <div
                      data-highlight={i === selected || undefined}
                      className={`group relative flex items-center gap-1 rounded-xl ${
                        active ? 'font-bold' : 'hover:bg-[var(--color-panel)]'
                      }`}
                    >
                      <button
                        onClick={() => pickConnection(c.id)}
                        className="relative flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left"
                      >
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{
                            background:
                              c.colour ||
                              (connected ? 'var(--color-success)' : 'var(--color-border-strong)'),
                          }}
                          title={connected ? 'connected' : 'not connected'}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{c.name}</span>
                          <span className="block truncate font-normal text-[var(--color-faint)]">
                            {pending === c.id && busy
                              ? 'Connecting…'
                              : describeConnection(c.kind, c.host, c.file)}
                            <TlsTag conn={c} />
                          </span>
                        </span>
                      </button>
                      <button
                        onClick={() => setDialog({ kind: 'connection', connection: c })}
                        title={`Edit ${c.name}`}
                        aria-label={`Edit ${c.name}`}
                        className={ICON_BUTTON}
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => removeConnection(c)}
                        title={`Remove ${c.name}`}
                        aria-label={`Remove ${c.name}`}
                        className={`${ICON_BUTTON} mr-1 hover:text-[var(--color-danger)]`}
                      >
                        ×
                      </button>
                    </div>
                  </ConnectionMenu>
                )
              })}
            </Highlight>
            <div className="border-t border-[var(--color-border)] px-1.5 py-1.5">
              <button
                onClick={() => setDialog({ kind: 'connection', connection: null })}
                className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-[var(--color-accent)]"
              >
                <span className="w-2.5 shrink-0 text-center font-bold">+</span>
                New connection…
              </button>
            </div>
          </Step>

          {hasDatabaseStep && (
            <Step
              n={2}
              label="Database"
              summary={activeDatabase || undefined}
              open={step === 'database'}
              enabled={!!activeConnectionId}
              onOpen={() => setStep('database')}
            >
              {databases.length > 8 && (
                <div className="px-3 py-1">
                  <input
                    ref={dbFilter}
                    value={dbQuery}
                    onChange={(e) => {
                      setDbQuery(e.target.value)
                      setSelected(0)
                    }}
                    placeholder="Filter databases…  (Enter picks the highlighted one)"
                    spellCheck={false}
                    aria-label="Filter databases"
                    className={INPUT}
                  />
                </div>
              )}
              <Highlight className="max-h-[min(22rem,45vh)] overflow-y-auto px-1.5 pb-1.5" pillClassName={PILL}>
                {visibleDatabases.map((d, i) => (
                  <button
                    key={d}
                    onClick={() => pickDatabase(d)}
                    title={d}
                    data-highlight={i === selected || undefined}
                    className={`relative flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left ${
                      d === activeDatabase ? 'font-bold' : 'hover:bg-[var(--color-panel)]'
                    }`}
                  >
                    <span className="shrink-0 text-[var(--color-faint)]">▪</span>
                    <span className="min-w-0 flex-1 truncate">{d}</span>
                  </button>
                ))}
              </Highlight>
            </Step>
          )}

          <Step
            n={hasDatabaseStep ? 3 : 2}
            label="Table"
            hint={
              activeConnectionId
                ? `${formatCount(objects.length)} ${objects.length === 1 ? 'object' : 'objects'}`
                : undefined
            }
            open={step === 'table'}
            enabled={!!activeConnectionId}
            onOpen={() => setStep('table')}
            last
          >
            {activeConnectionId && (
              <>
                <div className="px-3 py-1">
                  <input
                    ref={tableFilter}
                    value={objectQuery}
                    onChange={(e) => {
                      setObjectQuery(e.target.value)
                      setSelected(0)
                    }}
                    placeholder="Filter objects…  (Enter opens the highlighted one)"
                    spellCheck={false}
                    aria-label="Filter objects"
                    className={INPUT}
                  />
                </div>
                <Highlight
                  className="max-h-[min(26rem,50vh)] overflow-y-auto px-1.5 pb-2"
                  pillClassName={PILL}
                >
                  {objects.length === 0 && (
                    <p className="px-2 py-2 text-[var(--color-faint)]">
                      {busy ? 'Loading…' : 'No objects'}
                    </p>
                  )}
                  <ObjectListMenu>
                    {GROUP_ORDER.map((type) => {
                      const list = grouped.get(type)
                      if (!list || list.length === 0) return null
                      return (
                        <section key={type} className="mt-2">
                          <h3 className="flex items-center gap-1.5 px-2.5 pb-1 font-bold tracking-wider text-[var(--color-faint)] uppercase">
                            {GROUP_LABEL[type]}
                            <span
                              className="rounded-full px-1.5 font-semibold text-[var(--color-text)]/70"
                              style={{ background: GROUP_TINT[type] }}
                            >
                              {list.length}
                            </span>
                          </h3>
                          {list.map((o) => {
                            const qualified = qualifiedName(o)
                            return (
                              <button
                                key={`${type}:${qualified}`}
                                onClick={() => openObject(o)}
                                title={qualified}
                                data-object={objectKey(o)}
                                data-highlight={objectIndex.get(o) === selected || undefined}
                                className="relative flex w-full items-center gap-2 rounded-lg px-2.5 py-[0.2rem] text-left hover:bg-[var(--color-panel)]"
                              >
                                <span className="shrink-0 text-[var(--color-faint)]">
                                  {OBJECT_ICON[o.type]}
                                </span>
                                <span className="min-w-0 flex-1 truncate">{qualified}</span>
                                {o.type === 'table' && (
                                  <TableMark
                                    tableKey={tableKey(activeConnectionId, {
                                      database: activeDatabase,
                                      schema: o.schema,
                                      name: o.name,
                                    })}
                                  />
                                )}
                                {o.rowEstimate != null && (
                                  <span
                                    className="shrink-0 text-[var(--color-faint)]"
                                    title="estimated row count"
                                  >
                                    ~{formatCount(o.rowEstimate)}
                                  </span>
                                )}
                              </button>
                            )
                          })}
                        </section>
                      )
                    })}
                  </ObjectListMenu>
                </Highlight>
              </>
            )}
          </Step>
        </div>
      </div>
    </div>
  )
})

/**
 * One accordion step. The body collapses by animating a grid row from 0fr to
 * 1fr, which needs no measured height, and takes the same duration as the
 * drawers so the whole app moves at one speed.
 */
function Step({
  n,
  label,
  summary,
  hint,
  colour,
  open,
  enabled,
  onOpen,
  last = false,
  children,
}: {
  n: number
  label: string
  /** What was chosen; its presence marks the step done. */
  summary?: string
  /** Shown when collapsed, without marking the step done. */
  hint?: string
  colour?: string
  open: boolean
  /** A step cannot be opened before the one it depends on is chosen. */
  enabled: boolean
  onOpen: () => void
  last?: boolean
  children: React.ReactNode
}) {
  const done = !!summary
  return (
    <section className={last ? '' : 'border-b border-[var(--color-border)]'}>
      <h2>
        <button
          onClick={onOpen}
          disabled={!enabled}
          aria-expanded={open}
          className={`flex w-full items-center gap-3 px-4 py-3 text-left ${
            enabled ? 'hover:bg-[var(--color-panel)]' : 'opacity-50'
          }`}
        >
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-bold ${
              done
                ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)]'
                : open
                  ? 'bg-[var(--color-accent-dim)] text-[var(--color-accent)]'
                  : 'bg-[var(--color-panel)] text-[var(--color-faint)]'
            }`}
          >
            {done && !open ? '✓' : n}
          </span>
          <span className="font-bold tracking-wider text-[var(--color-faint)] uppercase">{label}</span>
          {!summary && hint && !open && (
            <span className="ml-auto shrink-0 font-normal text-[var(--color-faint)]">{hint}</span>
          )}
          {summary && !open && (
            <span className="ml-auto flex min-w-0 items-center gap-2 font-semibold text-[var(--color-text)]">
              {colour && (
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colour }} />
              )}
              <span className="truncate">{summary}</span>
              <span className="shrink-0 font-normal text-[var(--color-faint)]">change</span>
            </span>
          )}
        </button>
      </h2>
      <div
        className={`grid transition-[grid-template-rows] duration-(--drawer-duration) ease-(--ease-snap) motion-reduce:transition-none ${
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
        inert={!open}
      >
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </section>
  )
}
