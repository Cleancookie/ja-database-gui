import { memo, useMemo, useState } from 'react'
import { describeConnection, formatCount, objectCandidate, OBJECT_ICON, qualifiedName } from '../commands'
import { tableKey } from '../edits'
import { rankCandidates } from '../fuzzy'
import { useStore } from '../store'
import type { ObjectType, SchemaObject } from '../types'
import { ConnectionMenu } from './ConnectionMenu'
import { Highlight } from './Highlight'
import { ObjectListMenu, objectKey } from './ObjectMenu'
import { TableMark } from './TableMark'

const GROUP_ORDER: ObjectType[] = ['table', 'view', 'function', 'procedure']
/** One pastel per object kind, so the groups are told apart at a glance. */
const GROUP_TINT: Record<ObjectType, string> = {
  table: 'var(--color-mint)',
  view: 'var(--color-sky)',
  function: 'var(--color-lemon)',
  procedure: 'var(--color-peach)',
}
const GROUP_LABEL: Record<ObjectType, string> = {
  table: 'Tables',
  view: 'Views',
  function: 'Functions',
  procedure: 'Procedures',
}

const INPUT =
  'w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-elevated)] px-2 py-1 outline-none placeholder:text-[var(--color-faint)]'
const PILL = 'rounded-lg bg-[var(--color-accent-dim)]/55'

/**
 * What a tab with nothing open shows: connection, then database, then table,
 * as three columns that fill left to right. Picking in one column reveals the
 * next, so the whole path stays visible and any step can be redone by clicking
 * back in an earlier column.
 *
 * Memoised and propless for the same reason the sidebar it replaces was: the
 * object list is not virtualised, and none of its cost is ever the reason a
 * parent re-rendered.
 */
export const Picker = memo(function Picker() {
  const connections = useStore((s) => s.connections)
  const connectedIds = useStore((s) => s.connectedIds)
  const activeConnectionId = useStore((s) => s.activeConnectionId)
  const capabilities = useStore((s) => s.capabilities)
  const databases = useStore((s) => s.databases)
  const activeDatabase = useStore((s) => s.activeDatabase)
  const objects = useStore((s) => s.objects)
  const connect = useStore((s) => s.connect)
  const selectDatabase = useStore((s) => s.selectDatabase)
  const openObject = useStore((s) => s.openObject)
  const setDialog = useStore((s) => s.setDialog)

  const [objectQuery, setObjectQuery] = useState('')
  const [dbQuery, setDbQuery] = useState('')

  const matched = useMemo(
    () =>
      objectQuery ? rankCandidates(objectQuery, objects, objectCandidate).map((r) => r.item) : objects,
    [objects, objectQuery],
  )
  const grouped = useMemo(() => {
    const out = new Map<ObjectType, SchemaObject[]>()
    for (const o of matched) {
      const list = out.get(o.type)
      if (list) list.push(o)
      else out.set(o.type, [o])
    }
    return out
  }, [matched])

  const visibleDatabases = useMemo(
    () =>
      dbQuery ? rankCandidates(dbQuery, databases, (d) => ({ name: d })).map((r) => r.item) : databases,
    [databases, dbQuery],
  )

  const showDatabases = !!activeConnectionId && !!capabilities?.serverHostsDatabases

  // Enter in the filter opens the best match, so a table is reachable without
  // leaving the keyboard: type a few letters, Enter.
  const openFirst = () => {
    const first = matched.find((o) => o.type === 'table' || o.type === 'view')
    if (first) void openObject(first)
  }

  return (
    <div className="chrome flex h-full min-h-0">
      <Column
        label="Connections"
        count={connections.length}
        action={{
          label: '+',
          title: 'New connection',
          onClick: () => setDialog({ kind: 'connection', connection: null }),
        }}
      >
        <Highlight className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" pillClassName={PILL}>
          {connections.length === 0 && (
            <p className="px-1.5 py-2 leading-relaxed text-[var(--color-faint)]">
              No connections yet. Press{' '}
              <kbd className="rounded-lg border border-[var(--color-border-strong)] px-1">
                Ctrl+Shift+P
              </kbd>{' '}
              and choose “New connection”.
            </p>
          )}
          {connections.map((c) => {
            const active = c.id === activeConnectionId
            return (
              <ConnectionMenu key={c.id} connection={c}>
                <button
                  onClick={() => connect(c.id)}
                  data-highlight={active || undefined}
                  className={`relative flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left ${
                    active ? 'font-bold' : 'hover:bg-[var(--color-elevated)] hover:shadow-xs'
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white"
                    style={{
                      background:
                        c.colour ||
                        (connectedIds.includes(c.id)
                          ? 'var(--color-success)'
                          : 'var(--color-border-strong)'),
                    }}
                    title={connectedIds.includes(c.id) ? 'connected' : 'not connected'}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{c.name}</span>
                    <span className="block truncate text-[var(--color-faint)]">
                      {describeConnection(c.kind, c.host, c.file)}
                    </span>
                  </span>
                </button>
              </ConnectionMenu>
            )
          })}
        </Highlight>
      </Column>

      {showDatabases && (
        <Column label="Databases" count={databases.length}>
          {databases.length > 8 && (
            <div className="px-2 pb-1">
              <input
                value={dbQuery}
                onChange={(e) => setDbQuery(e.target.value)}
                placeholder="Filter databases…"
                spellCheck={false}
                aria-label="Filter databases"
                className={INPUT}
              />
            </div>
          )}
          <Highlight className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" pillClassName={PILL}>
            {visibleDatabases.map((d) => (
              <button
                key={d}
                onClick={() => selectDatabase(d)}
                title={d}
                data-highlight={d === activeDatabase || undefined}
                className={`relative flex w-full items-center gap-1.5 rounded-lg px-2 py-[0.2rem] text-left ${
                  d === activeDatabase
                    ? 'font-bold'
                    : 'hover:bg-[var(--color-elevated)] hover:shadow-xs'
                }`}
              >
                <span className="shrink-0 text-[var(--color-faint)]">▪</span>
                <span className="min-w-0 flex-1 truncate">{d}</span>
              </button>
            ))}
          </Highlight>
        </Column>
      )}

      {activeConnectionId ? (
        <Column label="Objects" count={objects.length} wide last>
          <div className="px-2 pb-1">
            <input
              value={objectQuery}
              onChange={(e) => setObjectQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  openFirst()
                }
              }}
              placeholder="Filter objects…  (Enter opens the first match)"
              spellCheck={false}
              aria-label="Filter objects"
              // Keyboard-first: the path is chosen, the next thing is typing a name.
              autoFocus
              className={INPUT}
            />
          </div>
          <Highlight className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3" pillClassName={PILL}>
            {objects.length === 0 && (
              <p className="px-1.5 py-2 text-[var(--color-faint)]">No objects</p>
            )}
            <ObjectListMenu>
              {GROUP_ORDER.map((type) => {
                const list = grouped.get(type)
                if (!list || list.length === 0) return null
                return (
                  <section key={type} className="mt-2">
                    <h3 className="flex items-center gap-1.5 px-2 pb-1 font-bold tracking-wider text-[var(--color-faint)] uppercase">
                      {GROUP_LABEL[type]}
                      <span
                        className="rounded-full px-1.5 font-semibold text-[var(--color-text)]/70"
                        style={{ background: GROUP_TINT[type] }}
                      >
                        {list.length}
                      </span>
                    </h3>
                    {list.map((o) => {
                      const qualified = qualifiedName(o)
                      return (
                        <button
                          key={`${type}:${qualified}`}
                          onClick={() => openObject(o)}
                          title={qualified}
                          data-object={objectKey(o)}
                          className="relative flex w-full items-center gap-1.5 rounded-lg px-2 py-[0.2rem] text-left hover:bg-[var(--color-elevated)] hover:shadow-xs"
                        >
                          <span className="shrink-0 text-[var(--color-faint)]">
                            {OBJECT_ICON[o.type]}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{qualified}</span>
                          {o.type === 'table' && (
                            <TableMark
                              tableKey={tableKey(activeConnectionId, {
                                database: activeDatabase,
                                schema: o.schema,
                                name: o.name,
                              })}
                            />
                          )}
                          {o.rowEstimate != null && (
                            <span
                              className="shrink-0 text-[var(--color-faint)]"
                              title="estimated row count"
                            >
                              ~{formatCount(o.rowEstimate)}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </section>
                )
              })}
            </ObjectListMenu>
          </Highlight>
        </Column>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 text-[var(--color-muted)]">
          <p className="font-bold text-[var(--color-text)]">Choose a connection</p>
          <p>
            <kbd className="rounded-lg border border-[var(--color-border-strong)] px-1.5">Ctrl+P</kbd>{' '}
            works from anywhere to jump to a table
          </p>
        </div>
      )}
    </div>
  )
})

function Column({
  label,
  count,
  action,
  wide = false,
  last = false,
  children,
}: {
  label: string
  count: number
  action?: { label: string; title: string; onClick: () => void }
  /** The table list takes the room the other two leave. */
  wide?: boolean
  last?: boolean
  children: React.ReactNode
}) {
  return (
    <section
      className={`flex min-h-0 min-w-0 flex-col ${wide ? 'flex-[2]' : 'flex-1'} ${
        last ? '' : 'border-r border-[var(--color-border)]'
      }`}
    >
      <header className="flex items-center">
        <h2 className="flex flex-1 items-center gap-1 px-3 py-2.5 font-bold tracking-wider text-[var(--color-faint)] uppercase">
          {label}
          <span className="opacity-60">{count}</span>
        </h2>
        {action && (
          <button
            onClick={action.onClick}
            title={action.title}
            className="mr-2 rounded-full bg-[var(--color-elevated)] px-2 leading-6 font-bold text-[var(--color-muted)] shadow-xs hover:bg-[var(--color-accent)] hover:text-[var(--color-on-accent)]"
          >
            {action.label}
          </button>
        )}
      </header>
      {children}
    </section>
  )
}
