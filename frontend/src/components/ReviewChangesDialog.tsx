import { useEffect, useMemo, useRef } from 'react'
import { countOf, describeCounts } from '../edits'
import { useStore } from '../store'
import { Dialog, dialogButton } from '../ui'

/**
 * Every statement that is about to run, and the button that runs them.
 *
 * This is the only component that calls `applyStaged`. Accept, Preview and
 * Ctrl+S all land here with the SQL built but not sent, so a change reaches the
 * database only by the user pressing Run on a list they could read.
 *
 * A refusal — a stale row, a constraint, a bad value — keeps the dialog open
 * with the message and the failing statement marked. Nothing was written (the
 * set is one transaction), so the way out is Cancel, fix the cell, and review
 * again. Run stays disabled meanwhile: re-sending the same set would only fail
 * the same way.
 */
export function ReviewChangesDialog() {
  const review = useStore((s) => s.review)
  const edits = useStore((s) => s.staged.edits)
  const cancelReview = useStore((s) => s.cancelReview)
  const applyStaged = useStore((s) => s.applyStaged)
  const counts = useMemo(() => countOf(edits), [edits])
  const failedRef = useRef<HTMLLIElement>(null)

  const failedIndex = review?.failedIndex
  useEffect(() => {
    failedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [failedIndex])

  if (!review) return null
  const n = review.request.changes.length

  return (
    <Dialog
      open
      onClose={cancelReview}
      title={`Review ${n} statement${n === 1 ? '' : 's'}`}
      widthClass="w-[min(44rem,94vw)]"
      description="The statements that will run, in order, in one transaction"
      footer={
        <>
          <span className="text-[var(--color-muted)]">{describeCounts(counts)}</span>
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
          {review.failedIndex !== undefined && (
            <strong>Statement {review.failedIndex + 1}: </strong>
          )}
          {review.error}
          {review.statements.length > 0 && <> Nothing was changed.</>}
        </p>
      )}

      {review.status === 'loading' ? (
        <p className="px-5 py-6 text-[var(--color-muted)]">Building the statements…</p>
      ) : (
        <ol className="max-h-[50vh] overflow-auto py-2 font-[var(--font-mono)]">
          {review.statements.map((st, i) => {
            const failed = i === review.failedIndex
            return (
              <li
                key={i}
                ref={failed ? failedRef : undefined}
                aria-current={failed ? 'true' : undefined}
                className={`flex gap-3 px-5 py-1.5 ${
                  failed
                    ? 'bg-[var(--color-danger-dim)] shadow-[inset_3px_0_0_var(--color-danger)]'
                    : ''
                }`}
              >
                <span className="w-8 shrink-0 text-right text-[var(--color-faint)] select-none">
                  {i + 1}
                </span>
                <pre className="min-w-0 flex-1 break-words whitespace-pre-wrap">{st.display}</pre>
              </li>
            )
          })}
        </ol>
      )}
    </Dialog>
  )
}
