import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { formatCount, objectCandidate, OBJECT_ICON, qualifiedName } from '../../commands'
import { tableKey } from '../../edits'
import { rankCandidates } from '../../fuzzy'
import { useStore } from '../../store'
import type { ObjectType, SchemaObject } from '../../types'
import { Highlight } from '../Highlight'
import { ObjectListMenu, objectKey } from '../ObjectMenu'
import { TableMark } from '../TableMark'
import { INPUT, PILL, useFocusWhen, useListKeys } from './listKit'

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

/**
 * Every object in the tab's database, grouped by kind, under a filter field.
 * Enter in the field opens the highlighted one.
 *
 * Memoised and propless where it can be: it is the most expensive list in the
 * shell, and none of its cost should be the reason a parent re-rendered.
 */
export const ObjectList = memo(function ObjectList({
  active = false,
  className = '',
}: {
  active?: boolean
  className?: string
}) {
  const activeConnectionId = useStore((s) => s.activeConnectionId)
  const activeDatabase = useStore((s) => s.activeDatabase)
  const objects = useStore((s) => s.objects)
  const busy = useStore((s) => s.busy)
  const openObject = useStore((s) => s.openObject)

  const [query, setQuery] = useState('')
  const matched = useMemo(
    () => (query ? rankCandidates(query, objects, objectCandidate).map((r) => r.item) : objects),
    [objects, query],
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

  // The objects in the order they are drawn, which is the order the keys walk.
  const order = useMemo(() => GROUP_ORDER.flatMap((t) => grouped.get(t) ?? []), [grouped])
  const indexOf = useMemo(() => new Map(order.map((o, i) => [o, i])), [order])

  const root = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const { selected, setSelected, onKeyDown } = useListKeys(order.length, (i) => void openObject(order[i]))
  useEffect(() => {
    if (active) setSelected(0)
  }, [active, setSelected])
  useFocusWhen(active, () => field.current)
  useEffect(() => {
    root.current?.querySelector('[data-highlight]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  if (!activeConnectionId) return null

  return (
    <div ref={root} onKeyDown={onKeyDown} className="flex min-h-0 flex-col">
      <div className="px-3 py-1">
        <input
          ref={field}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0)
          }}
          placeholder="Filter objects…  (Enter opens the highlighted one)"
          spellCheck={false}
          aria-label="Filter objects"
          className={INPUT}
        />
      </div>
      <Highlight className={`overflow-y-auto px-1.5 pb-2 ${className}`} pillClassName={PILL}>
        {objects.length === 0 && (
          <p className="px-2 py-2 text-[var(--color-faint)]">{busy ? 'Loading…' : 'No objects'}</p>
        )}
        <ObjectListMenu>
          {GROUP_ORDER.map((type) => {
            const list = grouped.get(type)
            if (!list || list.length === 0) return null
            return (
              <section key={type} className="mt-2">
                <h3 className="flex items-center gap-1.5 px-2.5 pb-1 font-bold tracking-wider text-[var(--color-faint)] uppercase">
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
                      data-highlight={indexOf.get(o) === selected || undefined}
                      className="relative flex w-full items-center gap-2 rounded-lg px-2.5 py-[0.2rem] text-left hover:bg-[var(--color-panel)]"
                    >
                      <span className="shrink-0 text-[var(--color-faint)]">{OBJECT_ICON[o.type]}</span>
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
                        <span className="shrink-0 text-[var(--color-faint)]" title="estimated row count">
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
    </div>
  )
})
