import { useEffect, useMemo, useRef, useState } from 'react'
import { FILTER_INPUT_ID, registerFilterFocus } from '../commands'
import { filterCandidates, tokenAt } from '../completion'
import { useActiveKind, useStore } from '../store'
import { Editor, type EditorHandle } from '../ui'

/**
 * The Ctrl+F filter: a raw SQL fragment appended after WHERE.
 *
 * It applies on Enter rather than on every keystroke — a half-typed expression
 * is usually a syntax error, and firing a query per character would flood the
 * server with failures. See docs/adr/0002-raw-sql-filter.md.
 *
 * The single-line editor is here for the completion popup: the columns of the
 * table in front of you are exactly what a predicate is about, and typing them
 * from memory is where the typos were. Enter and Escape keep their meanings —
 * the editor declines both while the popup is open, so the popup gets them
 * first, which is what every other editor does.
 */
export function FilterBar() {
  const filter = useStore((s) => s.filter)
  const applyFilter = useStore((s) => s.applyFilter)
  const activeRef = useStore((s) => s.activeRef)
  const columns = useStore((s) => s.columns)
  const kind = useActiveKind()

  const [draft, setDraft] = useState(filter)
  const handle = useRef<EditorHandle>(null)

  // Opening a different table clears the filter in the store; the input has to
  // follow, or it would show a condition that is no longer applied.
  useEffect(() => {
    setDraft(filter)
  }, [filter, activeRef])

  // Ctrl+F and the palette both focus through here — see registerFilterFocus.
  useEffect(() => {
    registerFilterFocus(() => handle.current?.focusAndSelectAll())
    return () => registerFilterFocus(null)
  }, [])

  const dirty = draft !== filter
  const qualified = activeRef
    ? `${activeRef.schema ? `${activeRef.schema}.` : ''}${activeRef.name}`
    : ''

  const completion = useMemo(
    () => ({
      options: filterCandidates({ columns, objects: [], kind, hasSchemas: false }),
      tokenAt,
    }),
    [columns, kind],
  )

  return (
    <div className="chrome flex items-center gap-2.5 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2">
      {/* The open table's name. It used to live in the top bar; with that gone
          this is the row that is always above the grid, and the name belongs
          next to the filter that applies to it. */}
      {activeRef && (
        <span
          title={qualified}
          className="max-w-[14rem] shrink-0 truncate font-[var(--font-mono)] text-[var(--color-muted)]"
        >
          {qualified}
        </span>
      )}
      <span className="shrink-0 font-[var(--font-mono)] text-[var(--color-faint)]">
        WHERE
      </span>
      <Editor
        id={FILTER_INPUT_ID}
        handleRef={handle}
        value={draft}
        onChange={setDraft}
        onSubmit={() => void applyFilter(draft)}
        onCancel={() => {
          // First Escape reverts an unapplied edit; a second gives up focus.
          if (dirty) setDraft(filter)
          else handle.current?.blur()
        }}
        singleLine
        dialect={kind}
        completion={completion}
        placeholder="status = 'active' and created_at > now() - interval '7 days'"
        ariaLabel="Row filter, raw SQL after WHERE"
        className={`min-w-0 flex-1 rounded-xl border bg-[var(--color-elevated)] px-3 py-1 shadow-xs ${
          dirty ? 'border-[var(--color-warn)]' : 'border-[var(--color-border)]'
        }`}
      />
      {dirty && (
        <span className="shrink-0 rounded-full bg-[var(--color-warn-dim)] px-2 py-0.5 font-semibold text-[var(--color-warn)]">Enter to apply</span>
      )}
      {filter && !dirty && (
        <button
          onClick={() => void applyFilter('')}
          title="Clear filter"
          className="shrink-0 rounded-full px-2 text-[var(--color-muted)] hover:bg-[var(--color-danger-dim)] hover:text-[var(--color-danger)]"
        >
          ✕
        </button>
      )}
    </div>
  )
}
