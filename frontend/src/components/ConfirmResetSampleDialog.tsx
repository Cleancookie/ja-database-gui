import { sampleResetWarning } from "../sample";
import { useStore } from "../store";
import { Dialog, dialogButton } from "../ui";

/** Confirmation for rebuilding the sample database, which discards the user's edits to it. */
export function ConfirmResetSampleDialog() {
  const setDialog = useStore((s) => s.setDialog);
  const resetSample = useStore((s) => s.resetSample);
  const connected = useStore((s) =>
    s.connections.some(
      (c) =>
        c.name === "Sample database (SQLite)" && s.connectedIds.includes(c.id),
    ),
  );
  const close = () => setDialog({ kind: "none" });

  return (
    <Dialog
      open
      onClose={close}
      title="Reset the sample database?"
      widthClass="w-[min(26rem,92vw)]"
      footer={
        <>
          <button onClick={close} className={`ml-auto ${dialogButton.ghost}`}>
            Cancel
          </button>
          <button
            onClick={() => void resetSample()}
            className={dialogButton.dangerFilled}
          >
            Reset
          </button>
        </>
      }
    >
      <p className="px-4 py-4 leading-relaxed text-[var(--color-muted)]">
        {sampleResetWarning(connected)}
      </p>
    </Dialog>
  );
}
