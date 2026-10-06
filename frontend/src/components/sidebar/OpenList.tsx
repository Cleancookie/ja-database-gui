import { qualifiedName } from '../../commands'
import { tableKey } from '../../edits'
import { useStore } from '../../store'
import { sameRef } from '../../tabs'
import type { ObjectRef } from '../../types'
import { OpenDot } from '../OpenDot'
import { TableMark } from '../TableMark'

const HEADING = 'px-3 pt-2 pb-1 font-bold tracking-wider text-[var(--color-faint)] uppercase'
const ROW =
  'relative flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-[0.2rem] text-left hover:bg-[var(--color-panel)]'

/**
 * The top of an expanded tab, between the table search and the list of every
 * table: the tab's SQL editor, and the tables open in it, the one on screen in
 * bold. Each closes with its ×.
 */
export function OpenList() {
  const openTables = useStore((s) => s.openTables)
  const activeRef = useStore((s) => s.activeRef)
  const activeConnectionId = useStore((s) => s.activeConnectionId)
  const view = useStore((s) => s.view)
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
      <button
        onClick={() => setView('sql')}
        className={`${ROW} mt-1 w-full ${view === 'sql' ? 'font-bold' : ''}`}
        title="SQL editor (Ctrl+E)"
      >
        <span className="shrink-0 text-[var(--color-faint)]">›_</span>
        <span className="min-w-0 flex-1 truncate">SQL editor</span>
      </button>
      {openTables.length > 0 && (
        <>
          <h3 className={HEADING}>
            Open <span className="opacity-60">{openTables.length}</span>
          </h3>
          <div className="max-h-[30vh] overflow-y-auto">
            {openTables.map(({ ref }) => {
              const current = sameRef(activeRef, ref)
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
        </>
      )}
      <h3 className={HEADING}>All</h3>
    </div>
  )
}
