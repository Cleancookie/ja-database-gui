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

  const sep = <span className="text-[var(--color-faint)]">/</span>

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
        {/* A path, as in a repo header: where you are is the last segment,
            and the ones before it lead back. */}
        <h1 className="flex min-w-0 items-center gap-2">
          {step === 1 ? (
            <span className="font-bold">Servers</span>
          ) : (
            <>
              <button
                onClick={() => setBack(true)}
                title="Back to servers (Esc)"
                className="text-[var(--color-muted)] hover:text-[var(--color-accent)] hover:underline"
              >
                Servers
              </button>
              {sep}
              <span className="min-w-0 truncate text-[var(--color-muted)]">{connectionName}</span>
              {sep}
              <span className="font-bold">Databases</span>
            </>
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
