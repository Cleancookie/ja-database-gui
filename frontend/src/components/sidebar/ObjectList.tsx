import { useVirtualizer } from '@tanstack/react-virtual'
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

type Row = { kind: 'head'; type: ObjectType; count: number } | { kind: 'object'; o: SchemaObject; index: number }

/**
 * Every object in the tab's database, grouped by kind, under a filter field.
 * Enter in the field opens the highlighted one.
 *
 * Virtualised and memoised: it is always on screen, a database can hold
 * thousands of tables, and none of its cost should be the reason a parent
 * re-rendered.
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

  // The objects in the order they are drawn, which is the order the keys walk,
  // and the rows that draw them with a heading before each group.
  const { order, rows, rowOf } = useMemo(() => {
    const order: SchemaObject[] = []
    const rows: Row[] = []
    const rowOf: number[] = []
    for (const type of GROUP_ORDER) {
      const list = grouped.get(type)
      if (!list?.length) continue
      rows.push({ kind: 'head', type, count: list.length })
      for (const o of list) {
        rowOf.push(rows.length)
        rows.push({ kind: 'object', o, index: order.length })
        order.push(o)
      }
    }
    return { order, rows, rowOf }
  }, [grouped])

  const scroller = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (rows[i].kind === 'head' ? 30 : 24),
    overscan: 12,
  })
  const { selected, setSelected, onKeyDown } = useListKeys(order.length, (i) => void openObject(order[i]))
  useEffect(() => {
    if (active) setSelected(0)
  }, [active, setSelected])
  useFocusWhen(active, () => field.current)
  useEffect(() => {
    const row = rowOf[selected]
    if (row !== undefined) virtualizer.scrollToIndex(row, { align: 'auto' })
  }, [selected, rowOf, virtualizer])

  if (!activeConnectionId) return null

  return (
    <div onKeyDown={onKeyDown} className="flex min-h-0 flex-col">
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
      <div ref={scroller} className={`min-h-0 overflow-y-auto ${className}`}>
        <Highlight className="px-1.5 pb-2" pillClassName={PILL}>
          {objects.length === 0 && (
            <p className="px-2 py-2 text-[var(--color-faint)]">{busy ? 'Loading…' : 'No objects'}</p>
          )}
          <ObjectListMenu>
            <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((v) => {
                const row = rows[v.index]
                return (
                  <div
                    key={v.key}
                    data-index={v.index}
                    ref={virtualizer.measureElement}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${v.start}px)` }}
                  >
                    {row.kind === 'head' ? (
                      <h3 className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 font-bold tracking-wider text-[var(--color-faint)] uppercase">
                        {GROUP_LABEL[row.type]}
                        <span
                          className="rounded-full px-1.5 font-semibold text-[var(--color-text)]/70"
                          style={{ background: GROUP_TINT[row.type] }}
                        >
                          {row.count}
                        </span>
                      </h3>
                    ) : (
                      <ObjectRow
                        o={row.o}
                        highlighted={row.index === selected}
                        connectionId={activeConnectionId}
                        database={activeDatabase}
                        onOpen={openObject}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </ObjectListMenu>
        </Highlight>
      </div>
    </div>
  )
})

function ObjectRow({
  o,
  highlighted,
  connectionId,
  database,
  onOpen,
}: {
  o: SchemaObject
  highlighted: boolean
  connectionId: string
  database: string
  onOpen: (o: SchemaObject) => void
}) {
  const qualified = qualifiedName(o)
  return (
    <button
      onClick={() => onOpen(o)}
      title={qualified}
      data-object={objectKey(o)}
      data-highlight={highlighted || undefined}
      className="relative flex w-full items-center gap-2 rounded-lg px-2.5 py-[0.2rem] text-left hover:bg-[var(--color-panel)]"
    >
      <span className="shrink-0 text-[var(--color-faint)]">{OBJECT_ICON[o.type]}</span>
      <span className="min-w-0 flex-1 truncate">{qualified}</span>
      {o.type === 'table' && (
        <TableMark tableKey={tableKey(connectionId, { database, schema: o.schema, name: o.name })} />
      )}
      {o.rowEstimate != null && (
        <span className="shrink-0 text-[var(--color-faint)]" title="estimated row count">
          ~{formatCount(o.rowEstimate)}
        </span>
      )}
    </button>
  )
}
