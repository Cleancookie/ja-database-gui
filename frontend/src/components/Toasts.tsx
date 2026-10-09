import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type Toast, useStore } from '../store'
import { TOAST_MS, stackLayout } from '../toasts'

/**
 * Errors here are usually the database's own message about a filter or query,
 * so they are shown in full, in a monospace face, and stay until dismissed.
 *
 * The stack sits collapsed, older cards peeking out above the newest; pointing
 * at it (or tabbing into it) fans it out and pauses every timer, so a card
 * never vanishes from under the cursor.
 */
export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismissAll = useStore((s) => s.dismissAllToasts)
  const [expanded, setExpanded] = useState(false)
  const [heights, setHeights] = useState<Record<number, number>>({})

  // The stack is gone, so nothing will fire mouseleave to fold it back.
  useEffect(() => {
    if (toasts.length === 0) setExpanded(false)
  }, [toasts.length])

  if (toasts.length === 0) return null

  const order = [...toasts].reverse()
  const { cards, total } = stackLayout(
    order.map((t) => heights[t.id] ?? 56),
    expanded,
  )

  return (
    <div
      className="fixed right-4 bottom-4 z-50 flex w-[min(34rem,90vw)] flex-col items-end gap-2"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setExpanded(false)
      }}
    >
      {expanded && toasts.length > 1 && (
        <button
          onClick={dismissAll}
          className="animate-fade-in rounded-full border border-[var(--color-border-strong)] bg-[var(--color-elevated)] px-3 py-0.5 font-bold text-[var(--color-muted)] shadow-md hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
        >
          Clear all {toasts.length}
        </button>
      )}
      <div className="max-h-[calc(100vh-5rem)] w-full overflow-x-hidden overflow-y-auto">
        <div
          className="relative w-full transition-[height] duration-200 ease-[var(--ease-snap)]"
          style={{ height: total }}
        >
          {order.map((t, i) => (
            <ToastCard
              key={t.id}
              toast={t}
              layer={i}
              card={cards[i]}
              paused={expanded}
              onHeight={(h) => setHeights((m) => (m[t.id] === h ? m : { ...m, [t.id]: h }))}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function ToastCard({
  toast: t,
  layer,
  card,
  paused,
  onHeight,
}: {
  toast: Toast
  layer: number
  card: ReturnType<typeof stackLayout>['cards'][number]
  paused: boolean
  onHeight: (h: number) => void
}) {
  const dismiss = useStore((s) => s.dismissToast)
  const body = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight))
    ro.observe(el)
    onHeight(el.offsetHeight)
    return () => ro.disconnect()
    // onHeight is a fresh closure each render; only the element matters.
  }, [])

  // Restarts on every resume rather than keeping the remainder: a card the
  // user just looked at deserves its full time again.
  useEffect(() => {
    if (!t.autoDismiss || paused) return
    const timer = setTimeout(() => dismiss(t.id), TOAST_MS)
    return () => clearTimeout(timer)
  }, [t.autoDismiss, t.id, t.at, paused, dismiss])

  const error = t.kind === 'error'
  const behind = layer > 0 && !paused

  return (
    <div
      role={error ? 'alert' : 'status'}
      aria-hidden={!card.visible}
      inert={!card.visible || behind}
      className={`absolute right-0 bottom-0 left-0 origin-top overflow-hidden rounded-2xl border shadow-lg transition-[transform,height,opacity] duration-300 ease-[var(--ease-snap)] ${
        error
          ? 'border-[var(--color-danger)] bg-[var(--color-danger-dim)]'
          : 'border-[var(--color-border)] bg-[var(--color-elevated)]'
      }`}
      style={{
        height: card.height,
        transform: `translateY(${-card.y}px) scale(${card.scale})`,
        opacity: card.visible ? 1 : 0,
        zIndex: 100 - layer,
      }}
    >
      <div
        ref={body}
        className={`animate-slide-in flex items-start gap-2 px-4 py-3 transition-opacity duration-200 ${behind ? 'opacity-0' : ''}`}
      >
        <span
          className={`flex-1 font-[var(--font-mono)] leading-relaxed break-words ${
            error ? 'text-[var(--color-danger)]' : 'text-[var(--color-text)]'
          }`}
        >
          {t.message}
        </span>
        {t.count > 1 && (
          <span
            title={`Raised ${t.count} times`}
            className="shrink-0 rounded-full bg-[var(--color-border)] px-2 py-0.5 font-bold text-[var(--color-muted)]"
          >
            ×{t.count}
          </span>
        )}
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
