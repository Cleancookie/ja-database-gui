import { memo, useMemo, useState } from 'react'
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
 * A tab is one connection and one database. The active tab is expanded to its
 * tables once it has both — the SQL editor, the ones open in it, and every
 * table and view. Choosing them is the main panel's job (WorkspacePicker).
 * The others are one line each.
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
  // Clicking the live tab folds its tables away. Keyed by tab, so any switch —
  // click, key or palette — arrives unfolded.
  const [foldedTab, setFoldedTab] = useState<number | null>(null)
  const folded = foldedTab === activeTabId
  const pick = (id: number) => {
    if (id === activeTabId) setFoldedTab(folded ? null : id)
    else switchTab(id)
  }

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

  const at = rows.findIndex((r) => r.live)
  const before = rows.slice(0, at)
  const after = rows.slice(at + 1)
  const live = rows[at]
  const bound = isBound({ activeConnectionId, activeDatabase, capabilities })

  const row = (r: (typeof rows)[number]) => (
    <div
      key={r.id}
      data-item
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
        onClick={() => pick(r.id)}
        title={r.title}
        aria-current={r.live || undefined}
        aria-expanded={r.live ? !folded : undefined}
        className={`relative flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1.5 text-left ${
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
      style={{ width: open ? resize.size : 0, marginRight: open ? 0 : '-0.5rem' }}
      aria-hidden={!open}
      inert={!open}
      className={`shrink-0 overflow-hidden ${
        resize.dragging
          ? ''
          : 'transition-[width,margin,visibility] duration-(--drawer-duration) ease-(--ease-snap) motion-reduce:transition-none'
      } ${open ? 'visible' : 'invisible'}`}
    >
      <aside
        style={{ width: resize.size }}
        className={`chrome island relative flex h-full flex-col ${
          resize.dragging
            ? ''
            : 'transition-transform duration-(--drawer-duration) ease-(--ease-snap) motion-reduce:transition-none'
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
          {before.length > 0 && (
            <div data-highlight-clip className="max-h-[30%] shrink-0 overflow-y-auto">
              {before.map(row)}
            </div>
          )}
          {live && (
            // One card, sized to what it holds: a database with three tables
            // leaves the tabs below it in view rather than at the far bottom.
            // Past the space there is, the table list scrolls inside it.
            <section className="my-1 flex min-h-0 flex-initial flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-1 shadow-xs">
              {row(live)}
              {/* Rows of 1fr ↔ 0fr: a grid track animates to and from the
                content's own height, which `height: auto` cannot. */}
              <div
                inert={folded}
                className={`grid min-h-0 transition-[grid-template-rows,opacity,margin] duration-(--drawer-duration) ease-(--ease-snap) motion-reduce:transition-none ${
                  folded ? 'grid-rows-[0fr] opacity-0' : 'mt-1 grid-rows-[1fr]'
                }`}
              >
                <div className="ml-2.5 flex min-h-0 flex-col overflow-hidden border-l-2 border-[var(--color-accent)]/35">
                  {bound ? (
                    <ObjectList active={false}>{WORKSPACE_EXTRAS}</ObjectList>
                  ) : (
                    <p className="px-3 py-1.5 text-[var(--color-faint)]">
                      Choose the server and database in the main panel
                    </p>
                  )}
                </div>
              </div>
            </section>
          )}
          {after.length > 0 && (
            <div data-highlight-clip className="max-h-[30%] shrink-0 overflow-y-auto">
              {after.map(row)}
            </div>
          )}
        </Highlight>
      </aside>
    </div>
  )
})
