import { api } from '../api'
import { useStore } from '../store'
import { Dialog, dialogButton } from '../ui'

/** Asked when the window is closed with staged edits that were never saved. */
export function ConfirmCloseDialog() {
  const setDialog = useStore((s) => s.setDialog)
  const total = useStore((s) => s.stagedSummary.total)
  const close = () => setDialog({ kind: 'none' })

  return (
    <Dialog
      open
      onClose={close}
      title="Unsaved changes"
      widthClass="w-[min(26rem,92vw)]"
      footer={
        <>
          <button onClick={close} className={`ml-auto ${dialogButton.ghost}`}>
            Cancel
          </button>
          <button onClick={() => void api.quit()} className={dialogButton.dangerFilled}>
            Discard and close
          </button>
        </>
      }
    >
      <p className="px-4 py-4 leading-relaxed text-[var(--color-muted)]">
        {total === 1 ? '1 change has' : `${total} changes have`} not been saved. Closing the app
        discards {total === 1 ? 'it' : 'them'}.
      </p>
    </Dialog>
  )
}
