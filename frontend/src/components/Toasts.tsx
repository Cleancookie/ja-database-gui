import { useState } from 'react'
import { useStore } from '../store'

/**
 * Errors here are usually the database's own message about a filter or query,
 * so they are shown in full, in a monospace face, and stay until dismissed.
 */
export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)

  if (toasts.length === 0) return null

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(34rem,90vw)] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={`animate-slide-in pointer-events-auto flex items-start gap-2 rounded-2xl border px-4 py-3 shadow-lg ${
            t.kind === 'error'
              ? 'border-[var(--color-danger)] bg-[var(--color-danger-dim)]'
              : 'border-[var(--color-border)] bg-[var(--color-elevated)]'
          }`}
        >
          <span
            className={`flex-1 font-[var(--font-mono)] leading-relaxed break-words ${
              t.kind === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text)]'
            }`}
          >
            {t.message}
          </span>
          {t.action ? (
            <button
              onClick={() => {
                t.action!.run()
                dismiss(t.id)
              }}
              className="shrink-0 rounded-lg border border-[var(--color-border-strong)] px-1.5 py-0.5 font-bold text-[var(--color-text)] hover:border-[var(--color-accent)]"
            >
              {t.action.label}
            </button>
          ) : (
            <CopyButton text={t.message} />
          )}
          <button
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
            title="Dismiss"
            className="shrink-0 rounded-lg px-1 text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * Copying an error is what people actually do with one — paste it into a
 * search, a ticket, or a message. The label confirms the copy happened, since
 * there is no other feedback that it worked.
 */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard access can be refused (insecure origin, denied permission).
      // The textarea fallback works everywhere the app actually runs.
      const el = document.createElement('textarea')
      el.value = text
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      onClick={() => void copy()}
      aria-label={`${label} to clipboard`}
      title={`${label} to clipboard`}
      className="shrink-0 rounded-lg border border-[var(--color-border-strong)] px-1.5 py-0.5 text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
    >
      {copied ? 'Copied' : label}
    </button>
  )
}
