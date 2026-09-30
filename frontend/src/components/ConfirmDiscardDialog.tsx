import { useStore } from '../store'
import { Dialog, dialogButton } from '../ui'

/**
 * Asked before anything throws staged edits away: a page turn, a re-sort, a
 * refresh, another table, or Discard changes when there are many.
 *
 * "Keep editing" is first, so it takes focus and Enter cannot lose work.
 */
export function ConfirmDiscardDialog({
  count,
  proceed,
}: {
  count: number
  proceed: () => void | Promise<void>
}) {
  const setDialog = useStore((s) => s.setDialog)
  const close = () => setDialog({ kind: 'none' })

  return (
    <Dialog
      open
      onClose={close}
      title={`Discard ${count} staged change${count === 1 ? '' : 's'}?`}
      widthClass="w-[min(28rem,92vw)]"
      footer={
        <>
          <button onClick={close} className={`ml-auto ${dialogButton.secondary}`}>
            Keep editing
          </button>
          <button
            onClick={() => {
              close()
              void proceed()
            }}
            className={dialogButton.dangerFilled}
          >
            Discard
          </button>
        </>
      }
    >
      <p className="px-4 py-4 leading-relaxed text-[var(--color-muted)]">
        These edits have not been written to the database. Discarding them cannot be undone.
      </p>
    </Dialog>
  )
}
