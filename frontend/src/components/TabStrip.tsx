import { memo, useMemo, type ReactNode } from 'react'
import { isBound, useStore } from '../store'
import { Highlight } from './Highlight'
import { HOVER_PILL, PILL } from './sidebar/listKit'
import { tabLabel } from '../tabs'
import { BrowsePicker } from './sidebar/BrowsePicker'
import { LIMITS, Resizer, useResizable } from './Resizer'
import { ObjectList } from './sidebar/ObjectList'
import { TabMark } from './TableMark'

/**
 * The tab sidebar down the left edge.
 *
 * Two sections. Tabs: one line per tab, each the table or SQL editor it shows,
 * then its connection and database. Tables: every table and view in a database
 * of its own choosing, apart from the tabs: switching tabs leaves it be, and
 * changing it opens nothing. An unbound tab chooses its database in the main
 * panel (WorkspacePicker).
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
  const activeRef = useStore((s) => s.activeRef)
  const view = useStore((s) => s.view)
  const newTab = useStore((s) => s.newTab)
  const switchTab = useStore((s) => s.switchTab)
  const closeTab = useStore((s) => s.closeTab)

  const resize = useResizable('sidebarWidthPx', LIMITS.sidebar)
  const tabsFolded = useStore((s) => s.settings.tabsFolded)
  const tablesFolded = useStore((s) => s.settings.tablesFolded)
  const toggleSection = useStore((s) => s.toggleSection)

  const rows = useMemo(() => {
    const byId = new Map(connections.map((c) => [c.id, c]))
    return tabs.map((t) => {
      const live = t.id === activeTabId
      const f = live
        ? { activeConnectionId, activeDatabase, capabilities, activeRef, view }
        : (t.saved ?? {
            activeConnectionId: null,
            activeDatabase: '',
            capabilities: null,
            activeRef: null,
            view: 'data' as const,
          })
      const conn = f.activeConnectionId ? byId.get(f.activeConnectionId) : undefined
      return {
        id: t.id,
        live,
        ...tabLabel(f, conn?.name),
        colour: conn?.colour,
        connectionId: f.activeConnectionId,
        tableRef: f.activeRef,
      }
    })
  }, [
    tabs,
    activeTabId,
    connections,
    activeConnectionId,
    activeDatabase,
    capabilities,
    activeRef,
    view,
  ])

  const browseConnectionId = useStore((s) => s.browseConnectionId)
  const browseBusy = useStore((s) => s.browseBusy)
  const browsing = useStore((s) =>
    isBound({
      activeConnectionId: s.browseConnectionId,
      activeDatabase: s.browseDatabase,
      capabilities: s.browseCapabilities,
    }),
  )

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
        title={r.where ? `${r.name} — ${r.where}` : r.name}
        aria-current={r.live || undefined}
        className={`relative flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left ${
          r.live ? 'font-bold' : ''
        }`}
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: r.colour || 'var(--color-border-strong)' }}
        />
        <span className="min-w-0 flex-1 truncate">
          {r.name}
          {r.where && (
            <span className="ml-1.5 font-normal text-[var(--color-faint)]">{r.where}</span>
          )}
        </span>
        <TabMark connectionId={r.connectionId} tableRef={r.tableRef} />
      </button>
      <button
        onClick={() => closeTab(r.id)}
        title="Close tab (Ctrl+W)"
        aria-label={`Close ${r.name}`}
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
        className={`relative flex h-full flex-col gap-2 ${
          resize.dragging
            ? ''
            : 'transition-transform duration-(--drawer-duration) ease-(--ease-snap)'
        } ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <Resizer {...resize} axis="x" label="Resize the tab strip" className="right-0 z-10" />
        {/* The open card takes the height a folded one gives up. */}
        <section
          className={`chrome island relative flex flex-col ${
            tabsFolded
              ? 'shrink-0'
              : tablesFolded
                ? 'min-h-0 flex-1'
                : 'max-h-[40%] min-h-0 shrink-0'
          }`}
        >
          <div className="flex items-center">
            <SectionHead
              title="Tabs"
              count={tabs.length}
              folded={tabsFolded}
              controls="sidebar-tabs"
              onToggle={() => void toggleSection('tabs')}
            />
            <button
              onClick={newTab}
              title="New tab (Ctrl+T)"
              className="mr-2 rounded-full bg-[var(--color-elevated)] px-2 leading-6 font-bold text-[var(--color-muted)] shadow-xs hover:bg-[var(--color-accent)] hover:text-[var(--color-on-accent)]"
            >
              +
            </button>
          </div>
          <Fold id="sidebar-tabs" folded={tabsFolded}>
            <Highlight
              className="flex min-h-0 flex-1 flex-col border-t border-[var(--color-border)] p-1.5"
              pillClassName={PILL}
              hoverClassName={HOVER_PILL}
            >
              <div data-highlight-clip className="min-h-0 overflow-y-auto">
                {rows.map(row)}
              </div>
            </Highlight>
          </Fold>
        </section>
        <section
          className={`chrome island relative flex flex-col ${
            tablesFolded ? 'shrink-0' : 'min-h-0 flex-1'
          }`}
        >
          <div className="flex items-center gap-2 pr-2">
            <SectionHead
              title="Tables"
              folded={tablesFolded}
              controls="sidebar-tables"
              onToggle={() => void toggleSection('tables')}
            />
            <BrowsePicker />
          </div>
          <Fold id="sidebar-tables" folded={tablesFolded}>
            <Highlight
              className="flex min-h-0 flex-1 flex-col border-t border-[var(--color-border)] p-1.5"
              pillClassName={PILL}
              hoverClassName={HOVER_PILL}
            >
              {browsing ? (
                <ObjectList active={false} />
              ) : (
                <p className="px-3 py-1.5 text-[var(--color-faint)]">
                  {!browseConnectionId
                    ? 'Choose a server'
                    : browseBusy
                      ? 'Connecting…'
                      : 'Choose a database'}
                </p>
              )}
            </Highlight>
          </Fold>
        </section>
      </aside>
    </div>
  )
})

/** A card's title, which folds the card. */
function SectionHead({
  title,
  count,
  folded,
  controls,
  onToggle,
}: {
  title: string
  count?: number
  folded: boolean
  controls: string
  onToggle: () => void
}) {
  return (
    <h2 className="shrink-0">
      <button
        onClick={onToggle}
        aria-expanded={!folded}
        aria-controls={controls}
        title={folded ? `Show ${title.toLowerCase()}` : `Hide ${title.toLowerCase()}`}
        className="flex items-center gap-1.5 px-3 py-2 font-bold tracking-wider text-[var(--color-faint)] uppercase hover:text-[var(--color-muted)]"
      >
        <span
          aria-hidden
          className={`transition-transform duration-[calc(150ms*var(--motion))] ${folded ? '' : 'rotate-90'}`}
        >
          ›
        </span>
        {title}
        {count !== undefined && <span className="opacity-60">{count}</span>}
      </button>
    </h2>
  )
}

/**
 * A card's body. Rows of 1fr ↔ 0fr: a grid track animates to and from the
 * height of its content, which no height transition can.
 */
function Fold({ id, folded, children }: { id: string; folded: boolean; children: ReactNode }) {
  return (
    <div
      id={id}
      inert={folded}
      className={`grid min-h-0 flex-1 transition-[grid-template-rows,opacity] duration-(--drawer-duration) ease-(--ease-snap) motion-reduce:transition-none ${
        folded ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr]'
      }`}
    >
      <div className="flex min-h-0 flex-col overflow-hidden">{children}</div>
    </div>
  )
}
