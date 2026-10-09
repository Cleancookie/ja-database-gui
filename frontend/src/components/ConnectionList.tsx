import { useEffect, useRef, useState } from 'react'
import { describeConnection } from '../commands'
import { useStore } from '../store'
import { ConnectionMenu } from './ConnectionMenu'
import { Highlight } from './Highlight'
import { TlsTag } from './TlsTag'
import { ICON_BUTTON, HOVER_PILL, PILL, useFocusWhen, useListKeys } from './sidebar/listKit'

/**
 * The saved connections, with edit and remove on each row, a New connection
 * row, and the sample database offered when there is nothing saved yet.
 */
export function ConnectionList({
  active = false,
  onPicked,
  className = '',
}: {
  active?: boolean
  onPicked?: () => void
  className?: string
}) {
  const connections = useStore((s) => s.connections)
  const connectedIds = useStore((s) => s.connectedIds)
  const activeConnectionId = useStore((s) => s.activeConnectionId)
  const busy = useStore((s) => s.busy)
  const openWorkspace = useStore((s) => s.openWorkspace)
  const removeConnection = useStore((s) => s.removeConnection)
  const setDialog = useStore((s) => s.setDialog)
  const openSample = useStore((s) => s.openSample)

  // The row being connected to, so the click is acknowledged while it waits.
  const [pending, setPending] = useState<string | null>(null)
  useEffect(() => {
    if (!busy) setPending(null)
  }, [busy])

  const pick = (id: string) => {
    setPending(id)
    void openWorkspace(id)
    onPicked?.()
  }

  const root = useRef<HTMLDivElement>(null)
  const { selected, setSelected, onKeyDown } = useListKeys(connections.length, (i) =>
    pick(connections[i].id),
  )
  useEffect(() => {
    if (active)
      setSelected(
        Math.max(
          0,
          connections.findIndex((c) => c.id === activeConnectionId),
        ),
      )
    // Only on activation: a refresh of the list must not yank the highlight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  useFocusWhen(active, () => root.current)
  useEffect(() => {
    root.current?.querySelector('[data-highlight]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <div
      ref={root}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="outline-none focus-visible:outline-none"
    >
      <Highlight
        className={`overflow-y-auto px-1.5 pb-1.5 ${className}`}
        pillClassName={PILL}
        hoverClassName={HOVER_PILL}
      >
        {connections.length === 0 && (
          <p className="px-2 py-3 leading-relaxed text-[var(--color-faint)]">
            No connections yet. Add one to get started, or look around the sample database first.
          </p>
        )}
        {connections.map((c, i) => {
          const current = c.id === activeConnectionId
          const connected = connectedIds.includes(c.id)
          return (
            <ConnectionMenu key={c.id} connection={c}>
              <div
                data-item
                data-highlight={i === selected || undefined}
                className={`group relative flex items-center gap-1 rounded-xl ${
                  current ? 'font-bold' : ''
                }`}
              >
                <button
                  onClick={() => pick(c.id)}
                  className="relative flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{
                      background:
                        c.colour ||
                        (connected ? 'var(--color-success)' : 'var(--color-border-strong)'),
                    }}
                    title={connected ? 'connected' : 'not connected'}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{c.name}</span>
                    <span className="block truncate font-normal text-[var(--color-faint)]">
                      {pending === c.id && busy
                        ? 'Connecting…'
                        : describeConnection(c.kind, c.host, c.file)}
                      <TlsTag conn={c} />
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => setDialog({ kind: 'connection', connection: c })}
                  title={`Edit ${c.name}`}
                  aria-label={`Edit ${c.name}`}
                  className={ICON_BUTTON}
                >
                  ✎
                </button>
                <button
                  onClick={() => removeConnection(c)}
                  title={`Remove ${c.name}`}
                  aria-label={`Remove ${c.name}`}
                  className={`${ICON_BUTTON} mr-1 hover:text-[var(--color-danger)]`}
                >
                  ×
                </button>
              </div>
            </ConnectionMenu>
          )
        })}
      </Highlight>
      <div className="border-t border-[var(--color-border)] px-1.5 py-1.5">
        <button
          onClick={() => setDialog({ kind: 'connection', connection: null })}
          className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-[var(--color-muted)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-accent)]"
        >
          <span className="w-2.5 shrink-0 text-center font-bold">+</span>
          New connection…
        </button>
        <button
          onClick={() => void openSample()}
          className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-[var(--color-muted)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-accent)]"
        >
          <span className="w-2.5 shrink-0 text-center">▤</span>
          Open the sample database
        </button>
      </div>
    </div>
  )
}
