import { useMemo } from 'react'
import { countOf, describeCounts } from '../edits'
import { useStore } from '../store'
import { dialogButton } from '../ui'

/**
 * The strip that says edits exist and have not been written.
 *
 * Shown only while something is staged. Accept and Preview are the same button
 * in two coats — both open the review, and neither runs anything — because the
 * only thing that may write is Run in that dialog. This component subscribes to
 * the staged edits itself so the app shell never has to.
 */
export function PendingChangesBar() {
  const edits = useStore((s) => s.staged.edits)
  const reviewChanges = useStore((s) => s.reviewChanges)
  const discardChanges = useStore((s) => s.discardChanges)
  const counts = useMemo(() => countOf(edits), [edits])
  if (counts.total === 0) return null

  return (
    <div
      role="region"
      aria-label="Pending changes"
      className="chrome flex items-center gap-3 border-t border-[var(--color-warn)] bg-[var(--color-warn-dim)] px-3 py-2"
    >
      <span className="font-bold text-[var(--color-warn)]" aria-live="polite">
        {describeCounts(counts)}
      </span>
      <span className="text-[var(--color-muted)]">staged, nothing written yet</span>
      <div className="ml-auto flex items-center gap-2">
        <button type="button" onClick={discardChanges} className={dialogButton.danger}>
          Discard changes
        </button>
        <button
          type="button"
          onClick={() => void reviewChanges()}
          className={dialogButton.secondary}
        >
          Preview changes
        </button>
        <button type="button" onClick={() => void reviewChanges()} className={dialogButton.primary}>
          Accept changes
          <kbd className="ml-2 font-[var(--font-mono)] text-[0.75em] opacity-80">Ctrl+S</kbd>
        </button>
      </div>
    </div>
  )
}
