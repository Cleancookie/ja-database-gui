import { describeCounts } from '../edits'
import { useStore } from '../store'

/**
 * Staged changes, on the status strip along the bottom of the window.
 *
 * It is global on purpose: edits now survive switching tables, so a bar that
 * lived over one grid would hide work in the others. Accept and Preview are one
 * action in two coats — both open the review, and neither runs anything; only
 * Run in that dialog writes.
 *
 * It subscribes to the store's derived summary, which keeps its identity until a
 * count moves, and is mounted by the tray rather than by `App`, so staging an
 * edit re-renders this and nothing else.
 */
export function ChangesStatus() {
  const summary = useStore((s) => s.stagedSummary)
  const reviewChanges = useStore((s) => s.reviewChanges)
  const discardChanges = useStore((s) => s.discardChanges)
  const goToChangedTable = useStore((s) => s.goToChangedTable)
  if (summary.total === 0) return null

  const n = summary.total
  const t = summary.tables
  return (
    <div
      role="region"
      aria-label="Staged changes"
      className="flex h-full shrink-0 items-center gap-2 border-l border-[var(--color-warn)] bg-[var(--color-warn-dim)] px-3"
    >
      <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-warn)]" aria-hidden />
      <button
        type="button"
        onClick={() => void goToChangedTable()}
        title={`${describeCounts(summary)} — click to open the next changed table`}
        aria-live="polite"
        className="rounded-full font-semibold text-[var(--color-warn)] hover:underline"
      >
        {n} staged change{n === 1 ? '' : 's'} in {t} table{t === 1 ? '' : 's'}
      </button>
      <button type="button" onClick={() => void reviewChanges()} className={linkButton}>
        Accept <span className="font-[var(--font-mono)] opacity-70">Ctrl+S</span>
      </button>
      <button type="button" onClick={() => void reviewChanges()} className={linkButton}>
        Preview
      </button>
      <button
        type="button"
        onClick={discardChanges}
        className={`${linkButton} text-[var(--color-danger)]`}
      >
        Discard
      </button>
    </div>
  )
}

const linkButton =
  'rounded-full px-2 leading-5 font-semibold text-[var(--color-text)] hover:bg-[var(--color-elevated)]'
