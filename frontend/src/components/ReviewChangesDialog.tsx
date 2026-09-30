import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { describeCounts } from '../edits'
import { useStore } from '../store'
import { Dialog, dialogButton } from '../ui'
import type { RowChange, Statement } from '../types'

/**
 * Every statement that is about to run, and the button that runs them.
 *
 * This is the only component that calls `applyStaged`. Accept, Preview and
 * Ctrl+S all land here with the SQL built but not sent, so a change reaches the
 * database only by the user pressing Run on a list they could read.
 *
 * One dialog for everything staged, grouped by table. A statement shows its
 * `short` form — a string literal over 160 characters is cut — because one
 * UPDATE can carry a 200 KB document and that must never be in the DOM unless
 * asked for. "Show full" puts the whole statement in a scrollable box; "Copy
 * SQL" copies it without showing it.
 *
 * A refusal — a stale row, a constraint, a bad value — keeps the dialog open
 * with the message and the failing statement marked. Nothing was written (the
 * set is one transaction), so the way out is Cancel, fix the cell, and review
 * again. Run stays disabled meanwhile: re-sending the same set would only fail
 * the same way.
 */
export function ReviewChangesDialog() {
  const review = useStore((s) => s.review)
  const cancelReview = useStore((s) => s.cancelReview)
  const applyStaged = useStore((s) => s.applyStaged)
  const failedRef = useRef<HTMLLIElement>(null)

  const failedIndex = review?.failedIndex
  useEffect(() => {
    failedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [failedIndex])

  const groups = useMemo(
    () => (review ? groupByTable(review.statements, review.request.changes) : []),
    [review],
  )

  if (!review) return null
  const changes = review.request.changes
  const n = changes.length
  const counts = {
    updates: changes.filter((c) => c.op === 'update').length,
    inserts: changes.filter((c) => c.op === 'insert').length,
    deletes: changes.filter((c) => c.op === 'delete').length,
  }
  const tables = new Set(changes.map((c) => tableName(c))).size
  const failedTable = failedIndex !== undefined ? review.statements[failedIndex]?.table : undefined

  return (
    <Dialog
      open
      onClose={cancelReview}
      title={`Review ${n} statement${n === 1 ? '' : 's'} in ${tables} table${tables === 1 ? '' : 's'}`}
      widthClass="w-[min(48rem,94vw)]"
      description="The statements that will run, in order, in one transaction"
      footer={
        <>
          <span className="text-[var(--color-muted)]">
            {describeCounts({ ...counts, total: n })}
          </span>
          <button
            onClick={cancelReview}
            disabled={review.status === 'applying'}
            className={`ml-auto ${dialogButton.ghost}`}
          >
            Cancel
          </button>
          <button
            onClick={() => void applyStaged()}
            disabled={review.status !== 'ready'}
            className={dialogButton.primary}
          >
            {review.status === 'applying' ? 'Running…' : `Run ${n} statement${n === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      {review.error && (
        <p
          role="alert"
          className="border-b border-[var(--color-danger)] bg-[var(--color-danger-dim)] px-5 py-3 leading-relaxed text-[var(--color-danger)]"
        >
          {failedIndex !== undefined && (
            <strong>
              Statement {failedIndex + 1}
              {failedTable ? ` (${failedTable})` : ''}:{' '}
            </strong>
          )}
          {review.error}
        </p>
      )}

      {review.status === 'loading' ? (
        <p className="px-5 py-6 text-[var(--color-muted)]">Building the statements…</p>
      ) : (
        <div className="max-h-[55vh] overflow-auto py-1 font-[var(--font-mono)]">
          {groups.map((g) => (
            <section key={g.table}>
              <h3 className="sticky top-0 z-[1] flex items-baseline gap-2 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-5 py-1.5 font-bold">
                {g.table}
                <span className="font-normal text-[var(--color-muted)]">{g.summary}</span>
              </h3>
              <ol>
                {g.items.map(({ index, statement }) => (
                  <StatementRow
                    key={index}
                    index={index}
                    statement={statement}
                    failed={index === failedIndex}
                    rowRef={index === failedIndex ? failedRef : undefined}
                  />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  )
}

interface Group {
  table: string
  summary: string
  items: { index: number; statement: Statement }[]
}

function tableName(c: RowChange): string {
  return c.ref.schema ? `${c.ref.schema}.${c.ref.name}` : c.ref.name
}

/**
 * Statements grouped by table, each keeping its position in the flat list: that
 * number is what a conflict refers to, so it is the number shown.
 */
function groupByTable(statements: Statement[], changes: RowChange[]): Group[] {
  const groups = new Map<string, Group & { ops: Record<string, number> }>()
  statements.forEach((statement, index) => {
    let g = groups.get(statement.table)
    if (!g) {
      g = { table: statement.table, summary: '', items: [], ops: {} }
      groups.set(statement.table, g)
    }
    g.items.push({ index, statement })
    const op = changes[index]?.op ?? 'update'
    g.ops[op] = (g.ops[op] ?? 0) + 1
  })
  return [...groups.values()].map((g) => ({
    table: g.table,
    items: g.items,
    summary: (['update', 'insert', 'delete'] as const)
      .filter((op) => g.ops[op])
      .map((op) => `${g.ops[op]} ${op}${g.ops[op] === 1 ? '' : 's'}`)
      .join(', '),
  }))
}

/** How many columns' chips one statement shows before folding the rest. */
const MAX_CHIPS = 8

const StatementRow = memo(function StatementRow({
  index,
  statement,
  failed,
  rowRef,
}: {
  index: number
  statement: Statement
  failed: boolean
  rowRef?: React.Ref<HTMLLIElement>
}) {
  const [full, setFull] = useState(false)
  const copyText = useStore((s) => s.copyText)
  const cut = statement.short !== statement.display

  return (
    <li
      ref={rowRef}
      aria-current={failed ? 'true' : undefined}
      className={`flex gap-3 px-5 py-1.5 ${
        failed ? 'bg-[var(--color-danger-dim)] shadow-[inset_3px_0_0_var(--color-danger)]' : ''
      }`}
    >
      <span className="w-8 shrink-0 text-right text-[var(--color-faint)] select-none">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        {/* The full text is only mounted on request: the default is the short
            form, so a 200 KB value costs nothing until someone asks. */}
        <pre
          className={`break-words whitespace-pre-wrap ${
            full ? 'max-h-64 overflow-auto rounded-lg bg-[var(--color-panel)] p-2' : ''
          }`}
        >
          {full ? statement.display : statement.short}
        </pre>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[0.85em]">
          {statement.cells.slice(0, MAX_CHIPS).map((c) => (
            <span
              key={c.column}
              className="rounded-full bg-[var(--color-accent-dim)]/50 px-2 text-[var(--color-muted)]"
            >
              {c.column} ·{' '}
              {c.kind === 'value' ? `${c.chars.toLocaleString()} chars` : c.kind.toUpperCase()}
            </span>
          ))}
          {statement.cells.length > MAX_CHIPS && (
            <span className="text-[var(--color-faint)]">
              +{statement.cells.length - MAX_CHIPS} more columns
            </span>
          )}
          <span className="ml-auto flex gap-1 font-[var(--font-sans)]">
            {cut && (
              <button
                type="button"
                onClick={() => setFull((f) => !f)}
                className="rounded-full px-2 font-semibold text-[var(--color-accent)] hover:bg-[var(--color-accent-dim)]/40"
              >
                {full ? 'Show short' : 'Show full'}
              </button>
            )}
            <button
              type="button"
              onClick={() => void copyText(statement.display)}
              className="rounded-full px-2 font-semibold text-[var(--color-muted)] hover:bg-[var(--color-accent-dim)]/40"
            >
              Copy SQL
            </button>
          </span>
        </div>
      </div>
    </li>
  )
})
