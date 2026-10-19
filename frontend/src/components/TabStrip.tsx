import { memo, useMemo } from 'react'
import { isBound, useStore } from '../store'
import { Highlight } from './Highlight'
import { HOVER_PILL, PILL } from './sidebar/listKit'
import { tabTitle } from '../tabs'
import { LIMITS, Resizer, useResizable } from './Resizer'
import { ObjectList } from './sidebar/ObjectList'
import { OpenList } from './sidebar/OpenList'
import { TabMark } from './TableMark'

/** Stable, so the memoised ObjectList is not re-rendered by a new element each time. */
const WORKSPACE_EXTRAS = <OpenList />

/**
 * The tab sidebar down the left edge.
 *
 * Two sections. Tabs: one line per tab, each a connection and a database.
 * Tables: the active tab's — the SQL editor, the ones open in it, then every
 * table and view. Choosing the database is the main panel's job (WorkspacePicker).
 *
 * It lives in the app shell, so it subscribes to as little as it can: the tab
 * list, and the handful of live fields that name the active tab. Never the grid
 * selection or the staged edits — the dirty dots are boolean selectors.
 */
export const TabStrip = memo(function TabStrip({ open }: { open: boolean }) {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const connections = useStore((s) => s.connections)
  const activeConnectionId = useStore((s) => s.activeConnectionId)
  const activeDatabase = useStore((s) => s.activeDatabase)
  const capabilities = useStore((s) => s.capabilities)
  const newTab = useStore((s) => s.newTab)
  const switchTab = useStore((s) => s.switchTab)
  const closeTab = useStore((s) => s.closeTab)

  const resize = useResizable('sidebarWidthPx', LIMITS.sidebar)

  const rows = useMemo(() => {
    const byId = new Map(connections.map((c) => [c.id, c]))
    return tabs.map((t) => {
      const live = t.id === activeTabId
      const f = live
        ? { activeConnectionId, activeDatabase, capabilities, openTables: [] }
        : (t.saved ?? {
            activeConnectionId: null,
            activeDatabase: '',
            capabilities: null,
            openTables: [],
          })
      const conn = f.activeConnectionId ? byId.get(f.activeConnectionId) : undefined
      return {
        id: t.id,
        live,
        title: tabTitle(f, conn?.name),
        colour: conn?.colour,
        connectionId: f.activeConnectionId,
        openTables: f.openTables,
      }
    })
  }, [tabs, activeTabId, connections, activeConnectionId, activeDatabase, capabilities])

  const live = rows.find((r) => r.live)
  const bound = isBound({ activeConnectionId, activeDatabase, capabilities })

  const row = (r: (typeof rows)[number]) => (
    <div
      key={r.id}
      data-item
      data-highlight={r.live || undefined}
      className="group relative flex items-center rounded-lg"
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
        title={r.title}
        aria-current={r.live || undefined}
        className={`relative flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left ${
          r.live ? 'font-bold' : ''
        }`}
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: r.colour || 'var(--color-border-strong)' }}
        />
        <span className="min-w-0 flex-1 truncate">{r.title}</span>
        {!r.live && <TabMark connectionId={r.connectionId} openTables={r.openTables} />}
        {!r.live && r.openTables.length > 0 && (
          <span className="shrink-0 font-normal text-[var(--color-faint)]" title="open tables">
            {r.openTables.length}
          </span>
        )}
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
  )

  return (
    // Two layers so it can slide: the outer one collapses its width (and the
    // shell's gap with it) while the island inside keeps its own width and
    // slides left, so the content is clipped rather than squashed.
    <div
      data-pane="left"
      style={{ width: open ? resize.size : 0, marginRight: open ? 0 : '-0.5rem' }}
      aria-hidden={!open}
      inert={!open}
      className={`shrink-0 overflow-hidden ${
        resize.dragging
          ? ''
          : 'transition-[width,margin,visibility] duration-(--drawer-duration) ease-(--ease-snap)'
      } ${open ? 'visible' : 'invisible'}`}
    >
      <aside
        style={{ width: resize.size }}
        className={`chrome island relative flex h-full flex-col ${
          resize.dragging
            ? ''
            : 'transition-transform duration-(--drawer-duration) ease-(--ease-snap)'
        } ${open ? 'translate-x-0' : '-translate-x-full'}`}
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
          className="flex min-h-0 flex-1 flex-col p-1.5"
          pillClassName={PILL}
          hoverClassName={HOVER_PILL}
        >
          <div data-highlight-clip className="max-h-[35%] shrink-0 overflow-y-auto">
            {rows.map(row)}
          </div>
          <h2 className="mt-1.5 flex items-baseline gap-2 border-t border-[var(--color-border)] px-1.5 pt-2.5 pb-1 font-bold tracking-wider text-[var(--color-faint)] uppercase">
            Tables
            {live && bound && (
              <span className="min-w-0 truncate font-normal tracking-normal normal-case">
                {live.title}
              </span>
            )}
          </h2>
          <div className="flex min-h-0 flex-1 flex-col">
            {bound ? (
              <ObjectList active={false}>{WORKSPACE_EXTRAS}</ObjectList>
            ) : (
              <p className="px-3 py-1.5 text-[var(--color-faint)]">
                Choose the server and database in the main panel
              </p>
            )}
          </div>
        </Highlight>
      </aside>
    </div>
  )
})
