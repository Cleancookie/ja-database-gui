import { useCallback, useMemo } from 'react'
import { editorCandidates, tokenAt } from '../completion'
import { activeSqlResult, useActiveKind, useHasSchemas, useStore } from '../store'
import { DatabasePicker } from './DatabasePicker'
import { Highlight } from './Highlight'
import { Editor } from '../ui'
import { useCellMenu } from './CellMenu'
import { DataGrid } from './DataGrid'

/**
 * SQL editor.
 *
 * Now a real editor rather than a textarea: highlighting and completion over
 * the objects in the open database, with Ctrl+Enter still running the
 * statement and Tab still indenting. See ui/Editor.tsx for why CodeMirror and
 * not Monaco.
 */
export function SqlEditor() {
  const sqlText = useStore((s) => s.sqlText)
  const setSqlText = useStore((s) => s.setSqlText)
  const runSql = useStore((s) => s.runSql)
  const sqlResults = useStore((s) => s.sqlResults)
  const sqlResultIndex = useStore((s) => s.sqlResultIndex)
  const moreSqlResults = useStore((s) => s.moreSqlResults)
  const selectSqlResult = useStore((s) => s.selectSqlResult)
  const sqlResult = useStore(activeSqlResult)
  const busy = useStore((s) => s.busy)
  const setView = useStore((s) => s.setView)
  const openCell = useStore((s) => s.openCell)
  const objects = useStore((s) => s.objects)
  const columns = useStore((s) => s.columns)
  const activeRef = useStore((s) => s.activeRef)
  const kind = useActiveKind()
  const hasSchemas = useHasSchemas()
  const cellMenu = useCellMenu('sql')
  // Stable for the same reason as in App, and here it is load-bearing: this
  // component subscribes to `sqlText`, so it re-renders on every keystroke. An
  // inline arrow would hand the memoised grid a new prop each time and repaint
  // the whole result while the user types.
  const onOpenCell = useCallback((row: number, col: number) => openCell('sql', row, col), [openCell])

  const completion = useMemo(
    () => ({
      options: editorCandidates({ columns, objects, kind, hasSchemas }, activeRef?.name),
      tokenAt,
    }),
    [columns, objects, kind, hasSchemas, activeRef],
  )

  return (
    <div className="flex h-full flex-col">
      <div className="chrome flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2">
        <span className="font-semibold tracking-wider text-[var(--color-faint)] uppercase">
          SQL
        </span>
        {/* Which database the statement will run against, and a way to change
            it without leaving the editor. Always rendered: as a chip shown
            only when a database was already chosen, it went missing in exactly
            the case where the user needed it most. */}
        <DatabasePicker />
        <button
          onClick={() => void runSql()}
          disabled={busy || !sqlText.trim()}
          className="rounded-full border border-[var(--color-border-strong)] bg-[var(--color-elevated)] px-3 py-0.5 font-semibold shadow-xs disabled:opacity-40 enabled:hover:border-[var(--color-accent)] enabled:hover:bg-[var(--color-accent-dim)]/30"
        >
          Run <span className="text-[var(--color-faint)]">Ctrl+Enter</span>
        </button>
        <button
          onClick={() => setView('data')}
          className="ml-auto rounded-lg px-1.5 text-[var(--color-muted)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)]"
          title="Close editor (Ctrl+E)"
        >
          ✕
        </button>
      </div>

      {/* Fixed height with its own scrolling, as the textarea had. The editor
          grows its own content area, so the height belongs on the wrapper. */}
      <div className="h-40 shrink-0 overflow-auto border-b border-[var(--color-border)] bg-[var(--color-elevated)]">
        <Editor
          autoFocus
          value={sqlText}
          onChange={setSqlText}
          onSubmit={() => void runSql()}
          dialect={kind}
          completion={completion}
          placeholder="select * from …"
          ariaLabel="SQL editor"
          className="p-3 leading-relaxed"
        />
      </div>

      {/* One tab per result set. A batch is one round trip that can answer
          several times over, and before this the later answers were dropped
          on the floor. Hidden for the single result that most runs produce. */}
      {sqlResults.length > 1 && (
        <Highlight className="chrome flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5">
          {sqlResults.map((r, i) => (
            <button
              key={i}
              onClick={() => selectSqlResult(i)}
              title={r.query}
              data-highlight={i === sqlResultIndex || undefined}
              className={`relative shrink-0 rounded-lg px-2 py-0.5 ${
                i === sqlResultIndex
                  ? 'font-bold text-[var(--color-accent)]'
                  : 'text-[var(--color-muted)] hover:bg-[var(--color-elevated)]'
              }`}
            >
              Result {i + 1}{' '}
              <span className="text-[var(--color-faint)]">
                {r.rows.length}
                {r.truncated ? '+' : ''}
              </span>
            </button>
          ))}
          {moreSqlResults && (
            <span
              className="shrink-0 px-2 text-[var(--color-warn)]"
              title="The batch produced more result sets than are shown"
            >
              more not shown
            </span>
          )}
        </Highlight>
      )}

      <div className="min-h-0 flex-1">
        {sqlResult ? (
          <DataGrid
            result={sqlResult}
            source="sql"
            onOpenCell={onOpenCell}
            cellMenu={cellMenu}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[var(--color-faint)]">
            Results appear here
          </div>
        )}
      </div>
    </div>
  )
}
