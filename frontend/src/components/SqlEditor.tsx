import { useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { editorCandidates, tokenAt } from '../completion'
import { effectiveIsolation, ISOLATION_WARNING, isolationChoices } from '../isolation'
import { focusEditorFromPane, runSqlFromEditor, sqlEditorHandle } from '../sqlEditorRun'
import { activeSqlResult, useActiveKind, useHasSchemas, useStore } from '../store'
import { DatabasePicker } from './DatabasePicker'
import { Highlight } from './Highlight'
import { Editor } from '../ui'
import { useCellMenu } from './CellMenu'
import { DataGrid } from './DataGrid'
import { LIMITS, Resizer, useResizable } from './Resizer'

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
  const hasSelection = useStore((s) => s.sqlHasSelection)
  const setHasSelection = useStore((s) => s.setSqlHasSelection)
  const sqlResults = useStore((s) => s.sqlResults)
  const sqlResultIndex = useStore((s) => s.sqlResultIndex)
  const moreSqlResults = useStore((s) => s.moreSqlResults)
  const selectSqlResult = useStore((s) => s.selectSqlResult)
  const sqlResult = useStore(activeSqlResult)
  const busy = useStore((s) => s.busy)
  const sqlRun = useStore((s) => s.sqlRun)
  const isolationLevels = useStore((s) => s.capabilities?.isolationLevels)
  const isolation = useStore((s) => s.sqlIsolation)
  const setIsolation = useStore((s) => s.setSqlIsolation)
  const cancelSql = useStore((s) => s.cancelSql)
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

  // The editor is gone with this view, and its selection with it.
  useEffect(() => () => setHasSelection(false), [setHasSelection])

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
          onClick={() => void runSqlFromEditor()}
          disabled={busy || !sqlText.trim()}
          title={hasSelection ? 'Run only the selected text' : 'Run the whole editor'}
          className="rounded-full border border-[var(--color-border-strong)] bg-[var(--color-elevated)] px-3 py-0.5 font-semibold shadow-xs disabled:opacity-40 enabled:hover:border-[var(--color-accent)] enabled:hover:bg-[var(--color-accent-dim)]/30"
        >
          {hasSelection ? 'Run selection' : 'Run'}{' '}
          <span className="text-[var(--color-faint)]">Ctrl+Enter</span>
        </button>
        {/* Hidden where the dialect has nothing to choose (SQLite). Lit when a
            level is set, because from then on every run is a transaction. */}
        {isolationLevels && isolationLevels.length > 0 && (
          <select
            aria-label="Transaction isolation level"
            title={`Isolation level for runs in this tab. ${ISOLATION_WARNING}`}
            value={effectiveIsolation(isolationLevels, isolation)}
            onChange={(e) => setIsolation(e.target.value)}
            className={`rounded-full border bg-[var(--color-elevated)] px-2 py-0.5 ${
              effectiveIsolation(isolationLevels, isolation)
                ? 'border-[var(--color-warn)] text-[var(--color-warn)]'
                : 'border-[var(--color-border-strong)] text-[var(--color-muted)]'
            }`}
          >
            {isolationChoices(isolationLevels).map((c) => (
              <option key={c.value} value={c.value}>
                {c.value ? `Tx: ${c.label}` : c.label}
              </option>
            ))}
          </select>
        )}
        {/* Separate from Run, not a toggle of it: Run stays where it was so the
            next press is never a stop by accident. */}
        {sqlRun && (
          <button
            onClick={() => void cancelSql()}
            disabled={sqlRun.cancelled}
            title="Stop the running statement (Ctrl+.)"
            className="rounded-full border border-[var(--color-danger)] bg-[var(--color-elevated)] px-3 py-0.5 font-semibold text-[var(--color-danger)] disabled:opacity-60 enabled:hover:bg-[var(--color-danger)]/10"
          >
            {sqlRun.cancelled ? 'Cancelling…' : 'Cancel'}{' '}
            <span className="text-[var(--color-faint)]">Ctrl+.</span>
          </button>
        )}
        <button
          onClick={() => setView('data')}
          className="ml-auto rounded-lg px-1.5 text-[var(--color-muted)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)]"
          title="Close editor (Ctrl+E)"
        >
          ✕
        </button>
      </div>

      {/* The editor scrolls inside its pane; the editor grows its own content
          area, so the height belongs on the wrapper. */}
      <ResultsSplit
        top={
          <div
            className="h-full cursor-text overflow-auto bg-[var(--color-elevated)]"
            onMouseDown={focusEditorFromPane}
          >
            <Editor
              autoFocus
              value={sqlText}
              onChange={setSqlText}
              onSubmit={() => void runSqlFromEditor()}
              onHasSelectionChange={setHasSelection}
              handleRef={sqlEditorHandle}
              dialect={kind}
              completion={completion}
              placeholder="select * from …"
              ariaLabel="SQL editor"
              className="p-3 leading-relaxed"
            />
          </div>
        }
        bottom={
          <>
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
          </>
        }
      />
    </div>
  )
}

/**
 * The editor above, the results below, and a handle between them.
 *
 * The drag state lives here and not in SqlEditor, and both panes arrive as
 * props: React skips a child element whose identity has not changed, so a
 * pixel of drag re-renders this small shell and nothing inside either pane —
 * CodeMirror and the virtualised grid are only resized by CSS. The size is
 * committed to settings on release, like the tray.
 *
 * The top pane is a flex basis that may shrink, bounded by min heights on both
 * panes, so a small window squeezes the editor rather than losing the results.
 */
function ResultsSplit({ top, bottom }: { top: ReactNode; bottom: ReactNode }) {
  const resize = useResizable('sqlEditorHeightPx', LIMITS.sqlEditor)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="relative border-b border-[var(--color-border)]"
        style={{ flex: `0 1 ${resize.size}px`, minHeight: LIMITS.sqlEditor.min }}
      >
        {top}
        <Resizer {...resize} axis="y" label="Resize the editor" className="-bottom-0.5" />
      </div>
      <div className="flex min-h-24 flex-1 flex-col">{bottom}</div>
    </div>
  )
}
