import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { formatJson, jsonValueText, summarise, type JsonKind } from '../json'
import { initialOpen, treeKey, treeRows, type TreeRow } from '../jsonTree'
import { useStore } from '../store'
import { ContextMenu, type MenuItem } from '../ui'
import { Highlight } from './Highlight'

/**
 * A collapsible JSON tree.
 *
 * Hand-rolled rather than pulled in: a viewer library is tens of kilobytes with
 * its own theming to fight. It also stays outside `src/ui/` on purpose — that
 * layer exists to quarantine *vendor* APIs, and there is no vendor here.
 *
 * Rendered as a flat list of visible rows (see jsonTree.ts) with one focused
 * row, so the keyboard can walk it: arrows, Home/End, Left/Right to close and
 * open, and the menu key for the same menu a right-click gives. The tree holds
 * focus itself and points at the row with `aria-activedescendant`, so no row
 * needs to be a tab stop.
 */
export function JsonView({ value }: { value: unknown }) {
  const copyText = useStore((s) => s.copyText)
  const [open, setOpen] = useState(() => initialOpen(value))
  const rows = useMemo(() => treeRows(value, open), [value, open])
  // Focus is held by path, so it stays on the same node across an edit; the
  // index is the fallback when that node has gone.
  const [focusPath, setFocusPath] = useState(rows[0].path)
  const lastIndex = useRef(0)
  const found = rows.findIndex((r) => r.path === focusPath)
  const index = found >= 0 ? found : Math.min(lastIndex.current, rows.length - 1)
  lastIndex.current = index
  const focused = rows[index]

  // One menu root for the whole tree, with the clicked row in state — the same
  // arrangement the grid uses, and for the same reason: a Radix root per node
  // would be hundreds of them in a document of any size.
  const [target, setTarget] = useState<TreeRow | null>(null)
  // The value is replaced under us when the dialog finishes fetching a cut
  // cell in full, and a target left pointing into the old document would copy
  // data that is no longer on screen.
  useEffect(() => setTarget(null), [value])
  const hit = target ?? focused

  const treeRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const rowId = (i: number) => `${id}-row-${i}`

  const focusedId = rowId(index)
  useEffect(() => {
    document.getElementById(focusedId)?.scrollIntoView({ block: 'nearest' })
  }, [focusedId])

  const toggle = (path: string, to: boolean) =>
    setOpen((prev) => {
      if (prev.has(path) === to) return prev
      const next = new Set(prev)
      if (to) next.add(path)
      else next.delete(path)
      return next
    })

  const focusRow = (row: TreeRow) => {
    setFocusPath(row.path)
    treeRef.current?.focus({ preventScroll: true })
  }

  /** Raises a contextmenu at the focused row, which is how Radix opens. */
  const openMenu = () => {
    const el = document.getElementById(focusedId)
    if (!el) return
    setTarget(focused)
    const box = el.getBoundingClientRect()
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        clientX: Math.round(box.left + 24),
        clientY: Math.round(box.bottom),
      }),
    )
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault()
      openMenu()
      return
    }
    if (e.key === 'Enter' && focused.container) {
      e.preventDefault()
      toggle(focused.path, !focused.open)
      return
    }
    const step = treeKey(e.nativeEvent, rows, index)
    if (!step) return
    e.preventDefault()
    if ('focus' in step) setFocusPath(rows[step.focus].path)
    else toggle('open' in step ? step.open : step.close, 'open' in step)
  }

  const items = useMemo<MenuItem[]>(() => {
    const text = jsonValueText(hit.value)
    const json = formatJson(hit.value)
    return [
      {
        label: 'Copy key',
        // The root is the document itself and has no key. Left visible but
        // disabled so the menu keeps its shape from node to node.
        disabled: hit.name === null,
        onSelect: () => void copyText(hit.name ?? ''),
      },
      {
        label: 'Copy key path',
        onSelect: () => void copyText(hit.path),
      },
      {
        label: 'Copy value',
        separatorBefore: true,
        onSelect: () => void copyText(text),
      },
      {
        label: 'Copy value as JSON',
        // Identical for numbers, booleans, null and containers; the two differ
        // only for a string, where this one keeps the quotes and the escapes.
        disabled: json === text,
        onSelect: () => void copyText(json),
      },
    ]
  }, [hit.name, hit.path, hit.value, copyText])

  return (
    <ContextMenu items={items} heading={hit.path}>
      {/* Matches the cell dialog's text tab rather than the grid: both are for
          reading one value, not for scanning many. */}
      <div
        ref={treeRef}
        role="tree"
        aria-label="JSON document"
        tabIndex={0}
        aria-activedescendant={focusedId}
        onKeyDown={onKeyDown}
        className="p-3 font-[var(--font-mono)] leading-relaxed outline-none"
      >
        <Highlight pillClassName="rounded-lg bg-[var(--color-accent-dim)]/60">
          {rows.map((row, i) => (
            <Row
              key={row.path}
              id={rowId(i)}
              row={row}
              focused={i === index}
              onClick={() => {
                focusRow(row)
                if (row.container) toggle(row.path, !row.open)
              }}
              onContextMenu={() => {
                setTarget(row)
                setFocusPath(row.path)
              }}
            />
          ))}
        </Highlight>
      </div>
    </ContextMenu>
  )
}

function Row({
  id,
  row,
  focused,
  onClick,
  onContextMenu,
}: {
  id: string
  row: TreeRow
  focused: boolean
  onClick: () => void
  onContextMenu: () => void
}) {
  return (
    <div
      id={id}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.container ? row.open : undefined}
      aria-selected={focused}
      data-item
      data-highlight={focused || undefined}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className="relative flex items-baseline gap-2 px-1"
    >
      {/* One rule per level down the left edge: what makes the nesting
          readable once a document is more than two deep. */}
      {Array.from({ length: row.depth }, (_, d) => (
        <span
          key={d}
          aria-hidden
          className="w-3 shrink-0 self-stretch border-r border-[var(--color-border)]"
        />
      ))}
      <span aria-hidden className="w-3 shrink-0 text-[var(--color-faint)]">
        {row.container ? (row.open ? '▾' : '▸') : ''}
      </span>
      <Key name={row.name} />
      {row.container ? (
        <span className="text-[var(--color-faint)]">{summarise(row.value)}</span>
      ) : (
        <Scalar kind={row.kind} value={row.value} />
      )}
    </div>
  )
}

/** The root has no key; every other node is labelled with its key or index. */
function Key({ name }: { name: string | null }) {
  if (name === null) return null
  return <span className="shrink-0 text-[var(--color-accent)]">{name}:</span>
}

function Scalar({ kind, value }: { kind: JsonKind; value: unknown }) {
  if (kind === 'null') {
    // Same treatment as a NULL cell in the grid, for the same reason: it must
    // never be mistaken for the string "null".
    return <span className="text-[var(--color-faint)] italic">null</span>
  }
  if (kind === 'string') {
    return (
      <span className="break-all whitespace-pre-wrap text-[var(--color-success)]">
        {value as string}
      </span>
    )
  }
  return <span className="text-[var(--color-warn)]">{String(value)}</span>
}
