/**
 * The JSON tree as a flat list of visible rows, and the keys that move through
 * it. Pure, so the focus model is tested without rendering a tree.
 *
 * Flat rather than nested components: one focused row needs a "next" and a
 * "previous", which a list has and a recursion does not.
 */

import {
  jsonEntries,
  jsonKind,
  jsonPathChild,
  JSON_PATH_ROOT,
  type JsonKind,
  type JsonSeg,
} from './json'
import { listMove, moveIndex } from './listNav'

/** Nodes below this depth start collapsed, so a deep document opens readable. */
const AUTO_OPEN_DEPTH = 2

/** A container with more children than this starts collapsed regardless. */
const AUTO_OPEN_MAX_CHILDREN = 100

export interface TreeRow {
  /** JSONPath; also the row's identity, so focus and open state survive an edit. */
  path: string
  segs: JsonSeg[]
  /** Key or index; null for the root. */
  name: string | null
  value: unknown
  kind: JsonKind
  depth: number
  container: boolean
  open: boolean
  /** Index of the parent row, -1 for the root. */
  parent: number
  /** The parent is an array, so `name` is an index. */
  inArray: boolean
}

const isContainer = (k: JsonKind) => k === 'object' || k === 'array'

/** The containers that start open: the top two levels, unless they are huge. */
export function initialOpen(value: unknown): Set<string> {
  const open = new Set<string>()
  const walk = (v: unknown, path: string, depth: number) => {
    const kind = jsonKind(v)
    if (!isContainer(kind) || depth >= AUTO_OPEN_DEPTH) return
    const entries = jsonEntries(v)
    if (entries.length > AUTO_OPEN_MAX_CHILDREN) return
    open.add(path)
    for (const [k, child] of entries)
      walk(child, jsonPathChild(path, k, kind === 'array'), depth + 1)
  }
  walk(value, JSON_PATH_ROOT, 0)
  return open
}

/** Every row on screen, in order: a container's children follow it while it is open. */
export function treeRows(value: unknown, open: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (
    v: unknown,
    name: string | null,
    path: string,
    segs: JsonSeg[],
    depth: number,
    parent: number,
    inArray: boolean,
  ) => {
    const kind = jsonKind(v)
    const container = isContainer(kind)
    const isOpen = container && open.has(path)
    const me = rows.length
    rows.push({ path, segs, name, value: v, kind, depth, container, open: isOpen, parent, inArray })
    if (!isOpen) return
    const arr = kind === 'array'
    for (const [k, child] of jsonEntries(v)) {
      const seg = arr ? Number(k) : k
      walk(child, k, jsonPathChild(path, k, arr), [...segs, seg], depth + 1, me, arr)
    }
  }
  walk(value, null, JSON_PATH_ROOT, [], 0, -1, false)
  return rows
}

/** What a key does to the tree: move focus, or open or close a container. */
export type TreeStep = { focus: number } | { open: string } | { close: string }

/**
 * The tree's movement keys: up and down through what is visible, right to open
 * or step into a container, left to close one or step out to the parent —
 * the WAI-ARIA tree pattern, which is also how every file tree behaves.
 */
export function treeKey(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  rows: readonly TreeRow[],
  index: number,
): TreeStep | null {
  const move = listMove(e)
  if (move) return { focus: moveIndex(move, index, rows.length) }
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null
  const row = rows[index]
  if (!row) return null
  if (e.key === 'ArrowRight' && row.container) {
    if (!row.open) return { open: row.path }
    return rows[index + 1]?.parent === index ? { focus: index + 1 } : null
  }
  if (e.key === 'ArrowLeft') {
    if (row.container && row.open) return { close: row.path }
    return row.parent >= 0 ? { focus: row.parent } : null
  }
  return null
}
