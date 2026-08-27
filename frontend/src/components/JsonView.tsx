import { useEffect, useMemo, useState } from 'react'
import {
  formatJson,
  jsonEntries,
  jsonKind,
  jsonPathChild,
  jsonValueText,
  summarise,
  JSON_PATH_ROOT,
  type JsonKind,
} from '../json'
import { useStore } from '../store'
import { ContextMenu, type MenuItem } from '../ui'

/**
 * A collapsible JSON tree.
 *
 * Hand-rolled rather than pulled in: the whole component is the hundred lines
 * below, where a viewer library is tens of kilobytes with its own theming to
 * fight. It also stays outside `src/ui/` on purpose — that layer exists to
 * quarantine *vendor* APIs, and there is no vendor here.
 *
 * Every node carries its own JSONPath, built on the way down, so the right-click
 * menu can hand over the path without walking back up to find it.
 */

/** Nodes below this depth start collapsed, so a deep document opens readable. */
const AUTO_OPEN_DEPTH = 2

/** A container with more children than this starts collapsed regardless. */
const AUTO_OPEN_MAX_CHILDREN = 100

/** Whichever node was last right-clicked, and what the menu acts on. */
interface JsonTarget {
  name: string | null
  path: string
  value: unknown
}

export function JsonView({ value }: { value: unknown }) {
  const copyText = useStore((s) => s.copyText)
  // One menu root for the whole tree, with the clicked node in state — the same
  // arrangement the grid uses, and for the same reason: a Radix root per node
  // would be hundreds of them in a document of any size. State rather than a
  // ref because the items have to be built before Radix opens the content.
  const [target, setTarget] = useState<JsonTarget | null>(null)
  // The value is replaced under us when the dialog finishes fetching a cut
  // cell in full, and a target left pointing into the old document would copy
  // data that is no longer on screen.
  useEffect(() => setTarget(null), [value])

  const root: JsonTarget = { name: null, path: JSON_PATH_ROOT, value }
  const hit = target ?? root

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
      <div className="p-3 font-[var(--font-mono)] leading-relaxed">
        <Node name={null} value={value} path={JSON_PATH_ROOT} depth={0} onTarget={setTarget} />
      </div>
    </ContextMenu>
  )
}

function Node({
  name,
  value,
  path,
  depth,
  onTarget,
}: {
  name: string | null
  value: unknown
  path: string
  depth: number
  onTarget: (t: JsonTarget) => void
}) {
  const kind = jsonKind(value)
  const container = kind === 'object' || kind === 'array'
  const entries = container ? jsonEntries(value) : []
  const [open, setOpen] = useState(
    depth < AUTO_OPEN_DEPTH && entries.length <= AUTO_OPEN_MAX_CHILDREN,
  )

  // Right-clicking the key and right-clicking the value give the same menu:
  // the two things you might want — the name and the contents — are both on it
  // either way, so there is nothing to be gained by making the reader aim.
  const claim = () => onTarget({ name, path, value })

  if (!container) {
    return (
      <div className="flex gap-2" onContextMenu={claim}>
        <Key name={name} />
        <Scalar kind={kind} value={value} />
      </div>
    )
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        onContextMenu={claim}
        // The whole row toggles: a 10px triangle is a poor click target when
        // you are working down a nested document.
        className="flex w-full items-baseline gap-2 rounded-lg px-1 text-left hover:bg-[var(--color-elevated)]"
        aria-expanded={open}
      >
        <span className="w-3 shrink-0 text-[var(--color-faint)]">{open ? '▾' : '▸'}</span>
        <Key name={name} />
        <span className="text-[var(--color-faint)]">{summarise(value)}</span>
      </button>
      {open && (
        // The rule down the left edge is what makes the nesting level readable
        // once a document is more than two deep.
        <div className="ml-3 border-l border-[var(--color-border)] pl-3">
          {entries.map(([k, v]) => (
            <Node
              key={k}
              name={k}
              value={v}
              path={jsonPathChild(path, k, kind === 'array')}
              depth={depth + 1}
              onTarget={onTarget}
            />
          ))}
          {entries.length === 0 && <span className="text-[var(--color-faint)]">empty</span>}
        </div>
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
