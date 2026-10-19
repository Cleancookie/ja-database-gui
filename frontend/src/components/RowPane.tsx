import { memo } from 'react'
import { isCellTruncated } from '../cells'
import { activeSqlResult, useStore, type ResultSource } from '../store'
import type { ResultSet } from '../types'
import { editCellClass, useGridEdits } from '../useGridEdits'
import { CellBody, cellTitle } from './DataGrid'
import { LIMITS, Resizer, useResizable } from './Resizer'

/**
 * The record pane down the right edge: the grid's cursor row, one line per
 * column, as TablePlus's row detail does.
 *
 * Mirrors TabStrip's two layers so it slides the same way. It is the one
 * always-reachable pane that does subscribe to the selection, which is why the
 * body is only mounted while it is open, and why it reads the cursor's row and
 * column as numbers rather than the selection object: dragging a range along
 * one row re-renders nothing here.
 */
export const RowPane = memo(function RowPane({ open }: { open: boolean }) {
  const resize = useResizable('rowPaneWidthPx', LIMITS.rowPane)
  return (
    <div
      data-pane="right"
      style={{ width: open ? resize.size : 0, marginLeft: open ? 0 : '-0.5rem' }}
      aria-hidden={!open}
      inert={!open}
      className={`shrink-0 overflow-hidden ${
        resize.dragging
          ? ''
          : 'transition-[width,margin,visibility] duration-(--drawer-duration) ease-(--ease-snap)'
      } ${open ? 'visible' : 'invisible'}`}
    >
      <aside
        style={{ width: resize.size }}
        className={`chrome island relative flex h-full flex-col ${
          resize.dragging
            ? ''
            : 'transition-transform duration-(--drawer-duration) ease-(--ease-snap)'
        } ${open ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <Resizer {...resize} axis="x" invert label="Resize the record pane" className="left-0" />
        <h2 className="border-b border-[var(--color-border)] px-3 py-2 font-bold tracking-wider text-[var(--color-faint)] uppercase">
          Record
        </h2>
        {open && <RecordBody />}
      </aside>
    </div>
  )
})

/** Which grid is on screen: the table's, the editor's result, or none. */
function RecordBody() {
  const source = useStore((s): ResultSource | null =>
    s.view === 'sql' ? 'sql' : s.view === 'data' && s.activeRef ? 'browse' : null,
  )
  const result = useStore((s) =>
    source === 'sql' ? activeSqlResult(s) : source === 'browse' ? s.result : null,
  )
  if (!source || !result) return <Hint text="No result on screen" />
  return <Record source={source} result={result} />
}

function Record({ source, result }: { source: ResultSource; result: ResultSet }) {
  const row = useStore((s) => (s.selection?.source === source ? s.selection.focus.row : null))
  const col = useStore((s) => (s.selection?.source === source ? s.selection.focus.col : null))
  const ed = useGridEdits(source, result)
  const live = row !== null && row < ed.rowCount ? row : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {live === null && <Hint text="Select a cell to see its row" />}
      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5 font-[var(--font-mono)]">
        {result.columns.map((c, i) => {
          const view = live === null ? null : ed.cell(live, i)
          const cut = live !== null && isCellTruncated(result, live, i)
          return (
            <li
              key={c.name}
              className={`grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2 rounded-lg px-2 py-0.5 ${
                i === col && live !== null ? 'bg-[var(--color-elevated)]' : ''
              }`}
            >
              <span
                className="truncate text-[var(--color-muted)]"
                title={`${c.name} · ${c.dbType}`}
              >
                {c.name}
              </span>
              {view ? (
                <span
                  className={`truncate ${editCellClass(view.state, false)}`}
                  title={cellTitle(view, cut, result.textCap)}
                >
                  <CellBody view={view} cut={cut} />
                </span>
              ) : (
                <span className="truncate text-[var(--color-faint)]">{c.dbType}</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Hint({ text }: { text: string }) {
  return <p className="px-3 py-1.5 text-[var(--color-faint)]">{text}</p>
}
