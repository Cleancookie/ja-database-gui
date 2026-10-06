import { memo } from 'react'
import { tableKey } from '../edits'
import { useStore } from '../store'
import type { OpenTable } from '../tabs'

/**
 * The dot on a sidebar table that has staged changes.
 *
 * One of these sits in every row of a list that can hold thousands, so what it
 * costs on a change it does not care about is the whole question. It subscribes
 * with a selector that returns a boolean for its own key: zustand compares that
 * with `Object.is` and only re-renders the row whose answer flipped. The table
 * set it reads is rebuilt only when membership changes (see `withStaged`), so
 * typing in a cell does not even run a new lookup against a new set.
 */
export const TableMark = memo(function TableMark({ tableKey }: { tableKey: string }) {
  const dirty = useStore((s) => s.dirtyTables.has(tableKey))
  if (!dirty) return null
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-warn)]"
      title="Has staged changes"
      role="img"
      aria-label="has staged changes"
    />
  )
})

/**
 * The dot on a collapsed tab with staged changes in any of its open tables.
 * A boolean selector for the same reason as `TableMark`.
 */
export const TabMark = memo(function TabMark({
  connectionId,
  openTables,
}: {
  connectionId: string | null
  openTables: OpenTable[]
}) {
  const dirty = useStore(
    (s) =>
      !!connectionId && openTables.some((t) => s.dirtyTables.has(tableKey(connectionId, t.ref))),
  )
  if (!dirty) return null
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-warn)]"
      title="Has staged changes"
      role="img"
      aria-label="has staged changes"
    />
  )
})
