import { qualifiedName } from '../../commands'
import { tableKey } from '../../edits'
import { useStore } from '../../store'
import { sameRef } from '../../tabs'
import type { ObjectRef } from '../../types'
import { OpenDot } from '../OpenDot'
import { TableMark } from '../TableMark'

const ROW =
  'relative flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-[0.2rem] text-left'

/**
 * The top of an expanded tab, between the table search and the list of every
 * table: the tab's SQL editor once opened, and the tables open in it. The pill slides to
 * whichever is on screen. Each table closes with its ×.
 */
export function OpenList() {
  const openTables = useStore((s) => s.openTables)
  const activeRef = useStore((s) => s.activeRef)
  const activeConnectionId = useStore((s) => s.activeConnectionId)
  const view = useStore((s) => s.view)
  // The editor is listed once it has been opened, like a table.
  const sqlOpen = useStore((s) => s.view === 'sql' || !!s.sqlText || s.sqlRuns.length > 0)
  const setView = useStore((s) => s.setView)
  const openObject = useStore((s) => s.openObject)
  const closeOpenTable = useStore((s) => s.closeOpenTable)

  const show = (ref: ObjectRef) => {
    if (sameRef(activeRef, ref)) {
      if (view !== 'data' && view !== 'details') setView('data')
      return
    }
    const known = useStore
      .getState()
      .objects.find((o) => o.name === ref.name && o.schema === ref.schema)
    void openObject(known ?? { schema: ref.schema, name: ref.name, type: 'table' })
  }

  return (
    <div className="shrink-0 px-1.5">
      {(sqlOpen || openTables.length > 0) && (
        <>
          <div data-highlight-clip className="mt-1 max-h-[30vh] overflow-y-auto">
            {sqlOpen && (
              <button
                onClick={() => setView('sql')}
                data-item
                data-highlight={view === 'sql' || undefined}
                className={`${ROW} w-full ${view === 'sql' ? 'font-bold' : ''}`}
                title="SQL editor (Ctrl+E)"
              >
                <span className="shrink-0 text-[var(--color-faint)]">›_</span>
                <span className="min-w-0 flex-1 truncate">SQL editor</span>
              </button>
            )}
            {openTables.map(({ ref }) => {
              const current = view !== 'sql' && sameRef(activeRef, ref)
              const name = qualifiedName(ref)
              return (
                <div
                  key={name}
                  className="group flex items-center"
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault()
                      void closeOpenTable(ref)
                    }
                  }}
                >
                  <button
                    onClick={() => show(ref)}
                    title={name}
                    aria-current={current || undefined}
                    data-item
                    data-highlight={current || undefined}
                    className={`${ROW} ${current ? 'font-bold' : ''}`}
                  >
                    <OpenDot />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    {activeConnectionId && (
                      <TableMark tableKey={tableKey(activeConnectionId, ref)} />
                    )}
                  </button>
                  <button
                    onClick={() => void closeOpenTable(ref)}
                    title="Close table (Alt+W)"
                    aria-label={`Close ${name}`}
                    className="relative mr-1 shrink-0 rounded-full px-1.5 text-[var(--color-faint)] opacity-40 group-hover:opacity-100 hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)] focus-visible:opacity-100"
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>
          {/* Open above, every table below. */}
          <hr className="mx-2 my-1.5 border-[var(--color-border)]" />
        </>
      )}
    </div>
  )
}
