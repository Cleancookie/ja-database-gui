import { memo, useEffect, useRef, useState } from 'react'
import { formatCount } from '../commands'
import { useStore } from '../store'
import { ConnectionList } from './sidebar/ConnectionList'
import { DatabaseList } from './sidebar/DatabaseList'
import { ObjectList } from './sidebar/ObjectList'

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
 */
export const Picker = memo(function Picker() {
  const connections = useStore((s) => s.connections)
  const activeConnectionId = useStore((s) => s.activeConnectionId)
  const capabilities = useStore((s) => s.capabilities)
  const activeDatabase = useStore((s) => s.activeDatabase)
  const objectCount = useStore((s) => s.objects.length)

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

  const activeConnection = connections.find((c) => c.id === activeConnectionId)

  return (
    <div className="chrome flex h-full min-h-0 flex-col items-center overflow-y-auto px-4 pt-[8vh] pb-8">
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
            <ConnectionList active={step === 'connection'} className="max-h-[min(22rem,45vh)]" />
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
              <DatabaseList
                active={step === 'database'}
                onPicked={() => setStep('table')}
                className="max-h-[min(22rem,45vh)]"
              />
            </Step>
          )}

          <Step
            n={hasDatabaseStep ? 3 : 2}
            label="Table"
            hint={
              activeConnectionId
                ? `${formatCount(objectCount)} ${objectCount === 1 ? 'object' : 'objects'}`
                : undefined
            }
            open={step === 'table'}
            enabled={!!activeConnectionId}
            onOpen={() => setStep('table')}
            last
          >
            <ObjectList active={step === 'table'} className="max-h-[min(26rem,50vh)]" />
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
