import { useState } from 'react'
import { useStore } from '../store'
import { ConnectionList } from './ConnectionList'
import { DatabaseList } from './DatabaseList'

const KBD = 'rounded-lg border border-[var(--color-border-strong)] px-1.5 font-normal'

/**
 * The main panel of a tab with no database yet: choose the server, then the
 * database on it. Binding at once (SQLite, a saved database) skips step 2.
 */
export function WorkspacePicker() {
  const connectionName = useStore(
    (s) => s.connections.find((c) => c.id === s.activeConnectionId)?.name,
  )
  const hostsDatabases = useStore(
    (s) => !!s.activeConnectionId && !!s.capabilities?.serverHostsDatabases,
  )
  // Esc steps back without disconnecting, so the server stays chosen.
  const [back, setBack] = useState(false)
  const step = hostsDatabases && !back ? 2 : 1

  const stepMark = (n: number, label: string) => (
    <span
      className={`flex items-center gap-2 ${
        n === step ? 'font-bold text-[var(--color-text)]' : 'text-[var(--color-faint)]'
      }`}
    >
      <span
        className={`grid h-6 w-6 place-items-center rounded-full font-bold tabular-nums ${
          n === step
            ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)] shadow-xs'
            : n < step
              ? 'bg-[var(--color-accent-dim)]/60 text-[var(--color-accent)]'
              : 'bg-[var(--color-elevated)] text-[var(--color-muted)]'
        }`}
      >
        {n < step ? '✓' : n}
      </span>
      {label}
    </span>
  )

  return (
    <div
      className="chrome flex h-full items-center justify-center px-4"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && step === 2) {
          e.preventDefault()
          setBack(true)
        }
      }}
    >
      <div className="flex max-h-full w-full max-w-md flex-col gap-3 py-4">
        <h1 className="flex items-center gap-3">
          {stepMark(1, 'Server')}
          <span className="h-px w-6 bg-[var(--color-border-strong)]" />
          {stepMark(2, 'Database')}
          {step === 2 && connectionName && (
            <span className="min-w-0 truncate text-[var(--color-muted)]">on {connectionName}</span>
          )}
        </h1>
        <div className="min-h-0 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] py-1.5">
          {step === 1 ? (
            <ConnectionList active onPicked={() => setBack(false)} />
          ) : (
            <DatabaseList active />
          )}
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[var(--color-faint)]">
          <span>
            <kbd className={KBD}>↑</kbd> <kbd className={KBD}>↓</kbd> move
          </span>
          <span>
            <kbd className={KBD}>Enter</kbd> {step === 1 ? 'next' : 'open'}
          </span>
          {step === 2 && (
            <span>
              <kbd className={KBD}>Esc</kbd> back
            </span>
          )}
        </p>
      </div>
    </div>
  )
}
