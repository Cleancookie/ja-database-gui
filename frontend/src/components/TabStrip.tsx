import { memo, useMemo } from 'react'
import { tableKey } from '../edits'
import { useStore } from '../store'
import { tabTitle } from '../tabs'
import { Highlight } from './Highlight'
import { LIMITS, Resizer, useResizable } from './Resizer'
import { TableMark } from './TableMark'

/**
 * The vertical tab strip down the left edge.
 *
 * It lives in the app shell, so it subscribes to as little as it can: the tab
 * list, and the handful of live fields that name the active tab. Never the grid
 * selection or the staged edits — the dirty dot is a per-table boolean, the same
 * way the picker's rows do it.
 */
export const TabStrip = memo(function TabStrip() {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const connections = useStore((s) => s.connections)
  const view = useStore((s) => s.view)
  const activeRef = useStore((s) => s.activeRef)
  const activeDatabase = useStore((s) => s.activeDatabase)
  const activeConnectionId = useStore((s) => s.activeConnectionId)
  const newTab = useStore((s) => s.newTab)
  const switchTab = useStore((s) => s.switchTab)
  const closeTab = useStore((s) => s.closeTab)

  const resize = useResizable('sidebarWidthPx', LIMITS.sidebar)

  const rows = useMemo(() => {
    const byId = new Map(connections.map((c) => [c.id, c]))
    return tabs.map((t) => {
      const live = t.id === activeTabId
      const f = live
        ? { view, activeRef, activeDatabase, activeConnectionId }
        : (t.saved ?? { view: 'data' as const, activeRef: null, activeDatabase: '', activeConnectionId: null })
      const conn = f.activeConnectionId ? byId.get(f.activeConnectionId) : undefined
      return {
        id: t.id,
        live,
        title: tabTitle(f),
        where: [conn?.name, f.activeDatabase].filter(Boolean).join(' · '),
        colour: conn?.colour,
        dirtyKey:
          f.activeConnectionId && f.activeRef ? tableKey(f.activeConnectionId, f.activeRef) : null,
      }
    })
  }, [tabs, activeTabId, connections, view, activeRef, activeDatabase, activeConnectionId])

  return (
    <aside
      style={{ width: resize.size }}
      className={`chrome island relative flex shrink-0 flex-col ${
        resize.dragging ? '' : 'transition-[width] duration-75'
      }`}
    >
      <Resizer {...resize} axis="x" label="Resize the tab strip" className="right-0" />
      <div className="flex items-center border-b border-[var(--color-border)]">
        <h2 className="flex-1 px-3 py-2 font-bold tracking-wider text-[var(--color-faint)] uppercase">
          Tabs
          <span className="ml-1 opacity-60">{tabs.length}</span>
        </h2>
        <button
          onClick={newTab}
          title="New tab (Ctrl+T)"
          className="mr-2 rounded-full bg-[var(--color-elevated)] px-2 leading-6 font-bold text-[var(--color-muted)] shadow-xs hover:bg-[var(--color-accent)] hover:text-[var(--color-on-accent)]"
        >
          +
        </button>
      </div>
      <Highlight
        className="min-h-0 flex-1 overflow-y-auto p-1.5"
        pillClassName="rounded-xl bg-[var(--color-accent-dim)]/55"
      >
        {rows.map((r) => (
          <div
            key={r.id}
            data-highlight={r.live || undefined}
            className="group relative flex items-center rounded-xl"
            // Middle-click closes, as in a browser.
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                closeTab(r.id)
              }
            }}
          >
            <button
              onClick={() => switchTab(r.id)}
              title={r.where ? `${r.title} — ${r.where}` : r.title}
              aria-current={r.live || undefined}
              className={`relative flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1.5 text-left ${
                r.live ? 'font-bold' : 'hover:bg-[var(--color-elevated)] hover:shadow-xs'
              }`}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: r.colour || 'var(--color-border-strong)' }}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{r.title}</span>
                {r.where && (
                  <span className="block truncate font-normal text-[var(--color-faint)]">
                    {r.where}
                  </span>
                )}
              </span>
              {r.dirtyKey && <TableMark tableKey={r.dirtyKey} />}
            </button>
            <button
              onClick={() => closeTab(r.id)}
              title="Close tab (Ctrl+W)"
              aria-label={`Close ${r.title}`}
              className="relative mr-1 shrink-0 rounded-full px-1.5 text-[var(--color-faint)] opacity-0 group-hover:opacity-100 hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)] focus-visible:opacity-100"
            >
              ×
            </button>
          </div>
        ))}
      </Highlight>
    </aside>
  )
})
