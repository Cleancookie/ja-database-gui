import { useEffect, useState } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'

/**
 * Restores focus to whatever opened the dialog.
 *
 * Radix does this itself on an open → closed transition, but this app mounts
 * a dialog already-open and unmounts it to close, so that transition never
 * happens and Radix's own restore never runs. Papering over exactly this kind
 * of mismatch is what the adapter layer is for.
 *
 * The opener is captured with a lazy useState initialiser, which runs during
 * the first render — before Radix's effects move focus into the dialog. An
 * effect would run too late and capture the dialog's own first input.
 */
function useRestoreFocusOnUnmount() {
  const [opener] = useState(() => document.activeElement)

  useEffect(() => {
    return () => {
      if (!(opener instanceof HTMLElement) || !document.contains(opener)) return
      // After the unmount paint, or the browser resets focus to <body> again.
      // Only when focus was lost with the dialog: if something has taken it
      // since — or this is StrictMode's rehearsal unmount, with the dialog
      // still open and focused — it is not ours to move.
      requestAnimationFrame(() => {
        const now = document.activeElement
        if (now && now !== document.body) return
        opener.focus()
      })
    }
  }, [opener])
}

/**
 * A modal dialog.
 *
 * Radix supplies the parts that are tedious and easy to get subtly wrong:
 * focus is trapped inside while open, returned to whatever opened it on
 * close, background scroll is locked, and Escape and outside-clicks are
 * handled with the right event semantics.
 *
 * The API here is deliberately narrow — title, footer, children — rather than
 * re-exporting Radix's subcomponents. See ./README.md.
 */
export interface DialogProps {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  children: React.ReactNode
  /** Buttons, laid out along the bottom edge. */
  footer?: React.ReactNode
  /** Tailwind width class. Defaults to a medium dialog. */
  widthClass?: string
  /** Accessible description, when the title alone is not enough. */
  description?: string
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  widthClass = 'w-[min(32rem,92vw)]',
  description,
}: DialogProps) {
  useRestoreFocusOnUnmount()

  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="chrome animate-fade-in fixed inset-0 z-40 bg-[var(--color-scrim)] backdrop-blur-[3px]" />
        <RadixDialog.Content
          className={`chrome animate-pop-in-centred fixed top-1/2 left-1/2 z-40 max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-elevated)] shadow-2xl ${widthClass}`}
        >
          <RadixDialog.Title className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-elevated)] px-5 py-3.5 font-bold">
            {title}
          </RadixDialog.Title>
          {/* Always rendered: a dialog without a description is an
              accessibility gap, and leaving it out also makes Radix warn. */}
          <RadixDialog.Description className="sr-only">
            {description ?? `${typeof title === 'string' ? title : 'Dialog'} options`}
          </RadixDialog.Description>

          {children}

          {footer && (
            <div className="sticky bottom-0 flex items-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-panel)] px-5 py-3.5">
              {footer}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/**
 * A form dialog. Submitting runs `onSubmit`; the surrounding Dialog still owns
 * focus management, so the two compose without either knowing about the other.
 */
export function FormDialog({
  onSubmit,
  children,
  footer,
  ...dialog
}: DialogProps & { onSubmit: () => void }) {
  return (
    <Dialog {...dialog} footer={undefined}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit()
        }}
      >
        {children}
        {footer && (
          <div className="sticky bottom-0 flex items-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-panel)] px-5 py-3.5">
            {footer}
          </div>
        )}
      </form>
    </Dialog>
  )
}

/** Shared button styling, so dialog footers look the same everywhere. */
export const dialogButton = {
  primary:
    'rounded-xl bg-[var(--color-accent)] px-4 py-1.5 font-bold text-[var(--color-on-accent)] shadow-sm disabled:opacity-40 enabled:hover:brightness-110 enabled:hover:shadow-md',
  secondary:
    'rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-elevated)] px-4 py-1.5 font-semibold disabled:opacity-40 enabled:hover:border-[var(--color-accent)] enabled:hover:bg-[var(--color-accent-dim)]/30',
  ghost:
    'rounded-xl px-4 py-1.5 font-semibold text-[var(--color-muted)] hover:bg-[var(--color-accent-dim)]/30 hover:text-[var(--color-text)]',
  danger:
    'rounded-xl border border-[var(--color-border-strong)] px-4 py-1.5 font-semibold text-[var(--color-danger)] hover:border-[var(--color-danger)] hover:bg-[var(--color-danger)]/10',
  dangerFilled:
    'rounded-xl bg-[var(--color-danger)] px-4 py-1.5 font-bold text-[var(--color-on-accent)] shadow-sm hover:brightness-110 hover:shadow-md',
} as const

/**
 * A layer for an overlay that draws itself — the command palette — so it can
 * open over a dialog. Without one, the dialog beneath still owns the page: it
 * takes Escape, blocks the pointer and pulls focus back. As a layer of its own
 * the overlay is the top one while open, and the dialog gets focus back after.
 */
export function Layer({
  label,
  onClose,
  children,
}: {
  /** Names the overlay for assistive tech. */
  label: string
  onClose: () => void
  children: React.ReactNode
}) {
  useRestoreFocusOnUnmount()

  return (
    <RadixDialog.Root open onOpenChange={(next) => !next && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Content aria-describedby={undefined}>
          <RadixDialog.Title className="sr-only">{label}</RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
