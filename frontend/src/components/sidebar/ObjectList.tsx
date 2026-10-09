import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  formatCount,
  objectCandidate,
  OBJECT_ICON,
  qualifiedName,
  TABLE_SEARCH_ID,
} from '../../commands'
import { tableKey } from '../../edits'
import { rankCandidates } from '../../fuzzy'
import { useStore } from '../../store'
import type { ObjectType, SchemaObject } from '../../types'
import { ObjectListMenu, objectKey } from '../ObjectMenu'
import { refKey } from '../../recency'
import { openTableKeys } from '../../tabs'
import { Highlight } from '../Highlight'
import { OpenDot } from '../OpenDot'
import { TableMark } from '../TableMark'
import { HOVER_PILL, INPUT, PILL, useFocusWhen, useListKeys } from './listKit'

/** Only what has rows to browse; functions and procedures are reached from the palette. */
type Browsable = 'table' | 'view'
const GROUP_ORDER: Browsable[] = ['table', 'view']
/** One pastel per object kind, so the groups are told apart at a glance. */
const GROUP_TINT: Record<Browsable, string> = {
  table: 'var(--color-mint)',
  view: 'var(--color-sky)',
}
const GROUP_LABEL: Record<Browsable, string> = {
  table: 'Tables',
  view: 'Views',
}

type Row =
  | { kind: 'head'; type: Browsable; count: number }
  | { kind: 'object'; o: SchemaObject; index: number }

/**
 * Every table and view in the tab's database, grouped by kind, under a filter
 * field. Enter in the field opens the highlighted one. `children` sit between
 * the field and the list; pass a stable element, or the memo is lost.
 *
 * Virtualised and memoised: it is always on screen, a database can hold
 * thousands of tables, and none of its cost should be the reason a parent
 * re-rendered.
 */
export const ObjectList = memo(function ObjectList({
  active = false,
  className = '',
  children,
}: {
  active?: boolean
  className?: string
  children?: React.ReactNode
}) {
  const activeConnectionId = useStore((s) => s.activeConnectionId)
  const activeDatabase = useStore((s) => s.activeDatabase)
  const objects = useStore((s) => s.objects)
  const busy = useStore((s) => s.busy)
  const openObject = useStore((s) => s.openObject)
  const openTables = useStore((s) => s.openTables)
  const open = useMemo(() => openTableKeys(openTables), [openTables])
  const current = useStore((s) =>
    s.view !== 'sql' && s.activeRef
      ? refKey(s.activeDatabase, s.activeRef.schema, s.activeRef.name)
      : null,
  )

  const [query, setQuery] = useState('')
  const [folded, setFolded] = useState<ReadonlySet<Browsable>>(new Set())
  const toggleFold = (type: Browsable) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (!next.delete(type)) next.add(type)
      return next
    })
  // The keyboard highlight is only shown while the keys would move it.
  const [focused, setFocused] = useState(false)
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
      // A search looks through folded groups too: a hidden match is a miss.
      if (folded.has(type) && !query) continue
      for (const o of list) {
        rowOf.push(rows.length)
        rows.push({ kind: 'object', o, index: order.length })
        order.push(o)
      }
    }
    return { order, rows, rowOf }
  }, [grouped, folded, query])

  const scroller = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (rows[i].kind === 'head' ? 30 : 24),
    overscan: 12,
  })
  const { selected, setSelected, onKeyDown } = useListKeys(
    order.length,
    (i) => void openObject(order[i]),
  )
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
    <div
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (focused) return
        setFocused(true)
        // The key cursor starts where the pill already is, not back at the top.
        const at = order.findIndex((o) => refKey(activeDatabase, o.schema, o.name) === current)
        if (at >= 0) setSelected(at)
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false)
      }}
      className="flex min-h-0 flex-col"
    >
      <div className="px-3 py-1">
        <input
          ref={field}
          id={TABLE_SEARCH_ID}
          data-focus-home
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0)
          }}
          placeholder="Search tables…  (Ctrl+L)"
          spellCheck={false}
          aria-label="Search tables"
          className={INPUT}
        />
      </div>
      {children}
      <div ref={scroller} data-highlight-clip className={`min-h-0 overflow-y-auto ${className}`}>
        {/* Its own pill: one shared with the open tables glided between the two. */}
        <Highlight className="px-1.5 pb-2" pillClassName={PILL} hoverClassName={HOVER_PILL}>
          {objects.length === 0 && (
            <p className="px-2 py-2 text-[var(--color-faint)]">
              {busy ? 'Loading…' : 'No objects'}
            </p>
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
                      <h3>
                        <button
                          onClick={() => toggleFold(row.type)}
                          aria-expanded={!folded.has(row.type) || !!query}
                          title={folded.has(row.type) ? 'Show' : 'Hide'}
                          className="flex w-full items-center gap-1.5 px-2.5 pt-2 pb-1 font-bold tracking-wider text-[var(--color-faint)] uppercase hover:text-[var(--color-muted)]"
                        >
                          <span
                            aria-hidden
                            className={`transition-transform duration-150 motion-reduce:transition-none ${
                              folded.has(row.type) && !query ? '' : 'rotate-90'
                            }`}
                          >
                            ›
                          </span>
                          {GROUP_LABEL[row.type]}
                          <span
                            // Tinted text on a wash of the same tint: a pastel
                            // fill under theme text fails contrast on dark themes.
                            // Mixing in the text colour keeps pastels legible on
                            // light ones.
                            className="rounded-full px-1.5 font-semibold"
                            style={{
                              color: `color-mix(in srgb, ${GROUP_TINT[row.type]} 55%, var(--color-text))`,
                              background: `color-mix(in srgb, ${GROUP_TINT[row.type]} 18%, transparent)`,
                            }}
                          >
                            {row.count}
                          </span>
                        </button>
                      </h3>
                    ) : (
                      <ObjectRow
                        o={row.o}
                        // The keys move the pill while they would; otherwise it
                        // sits on the table on screen, as the open list's does.
                        highlighted={
                          focused
                            ? row.index === selected
                            : current === refKey(activeDatabase, row.o.schema, row.o.name)
                        }
                        open={open.has(refKey(activeDatabase, row.o.schema, row.o.name))}
                        connectionId={activeConnectionId}
                        database={activeDatabase}
                        onOpen={(o) => {
                          // A click focuses the list, which shows the key
                          // cursor; it has to be on the row that was opened.
                          setSelected(row.index)
                          void openObject(o)
                        }}
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
  open,
  connectionId,
  database,
  onOpen,
}: {
  o: SchemaObject
  highlighted: boolean
  open: boolean
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
      data-item
      data-highlight={highlighted || undefined}
      className="relative flex w-full items-center gap-2 rounded-lg px-2.5 py-[0.2rem] text-left"
    >
      <span className="shrink-0 text-[var(--color-faint)]">{OBJECT_ICON[o.type]}</span>
      <span className="min-w-0 flex-1 truncate">{qualified}</span>
      {open && <OpenDot />}
      {o.type === 'table' && (
        <TableMark
          tableKey={tableKey(connectionId, { database, schema: o.schema, name: o.name })}
        />
      )}
      {o.rowEstimate != null && (
        <span className="shrink-0 text-[var(--color-faint)]" title="estimated row count">
          ~{formatCount(o.rowEstimate)}
        </span>
      )}
    </button>
  )
}
