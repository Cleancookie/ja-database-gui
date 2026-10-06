import { useLayoutEffect, useRef } from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'

/**
 * The grid's selection, drawn as two overlays that glide.
 *
 * The same idea as Highlight.tsx, sized for a grid: the focus cell and the
 * selected range are each one element that moves, rather than a background
 * switching off in one cell and on in another. Geometry comes from the
 * virtualisers' measurements, never from the DOM — the focus may be on a cell
 * that is scrolled away and not mounted.
 *
 * The overlays sit under the cells (which are `z-[1]`) and over the row
 * stripes, so text stays crisp and the sticky chrome still paints on top.
 */

/** Cells on the drawn axes, inclusive: `y` down the row area, `x` across it. */
export interface CellSpan {
  y0: number
  y1: number
  x0: number
  x1: number
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface Props {
  /** Measurements of the drawn rows and columns, in content coordinates. */
  ys: VirtualItem[]
  xs: VirtualItem[]
  /** Where the row area starts in content coordinates: the header's height. */
  top: number
  focus: CellSpan | null
  range: CellSpan | null
  /** Cells carry a bottom border as well as a right one. */
  borderBottom?: boolean
}

export function GridSelection({ ys, xs, top, focus, range, borderBottom = false }: Props) {
  const f = focus && boxOf(ys, xs, focus, top)
  const r = range && boxOf(ys, xs, range, top)
  // A one-cell range is the focus alone; it stays placed, invisibly, so that
  // extending it grows the wash out of the focus cell rather than popping in.
  const wide = !!range && (range.y0 !== range.y1 || range.x0 !== range.x1)
  // The ring is inset, so it is kept inside the cell's own borders or they
  // would paint over its right and bottom edges.
  const ring = f && { ...f, w: f.w - 1, h: f.h - (borderBottom ? 1 : 0) }
  // Any change to the measurements — a new result, a resized column, a page
  // appended — moves the overlays without animating them.
  const layout = [ys, xs, top]
  const rangeRef = useGlide(r, layout)
  const focusRef = useGlide(ring, layout)
  return (
    <>
      <div
        ref={rangeRef}
        aria-hidden
        className="highlight-pill grid-glide bg-[var(--color-accent-dim)]/30"
        style={place(r, wide)}
      />
      <div
        ref={focusRef}
        aria-hidden
        className="highlight-pill grid-glide bg-[var(--color-accent-dim)]/60 ring-1 ring-[var(--color-accent)] ring-inset"
        style={place(ring, true)}
      />
    </>
  )
}

function boxOf(ys: VirtualItem[], xs: VirtualItem[], s: CellSpan, top: number): Box | null {
  const [a, b, c, d] = [ys[s.y0], ys[s.y1], xs[s.x0], xs[s.x1]]
  // A selection briefly outlives the result it was made in.
  if (!a || !b || !c || !d) return null
  return { x: c.start, y: a.start - top, w: d.end - c.start, h: b.end - a.start }
}

function place(b: Box | null, shown: boolean): React.CSSProperties {
  if (!b) return { opacity: 0 }
  return {
    opacity: shown ? 1 : 0,
    width: b.w,
    height: b.h,
    transform: `translate3d(${b.x}px, ${b.y}px, 0)`,
  }
}

/**
 * Movement for one overlay, off for any placement that is not a move.
 *
 * Highlight enables movement a frame after first placement; a held arrow key
 * re-renders faster than that, so here the class is toggled directly instead.
 * Taking it off cancels anything in flight, and the forced style read commits
 * the jump before it goes back on, so re-enabling it cannot animate the jump.
 */
function useGlide(box: Box | null, layout: unknown[]) {
  const ref = useRef<HTMLDivElement>(null)
  const placed = useRef<unknown[] | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const key = box ? layout : null
    if (sameItems(placed.current, key)) return
    placed.current = key
    el.classList.remove('highlight-pill-moves')
    if (!key) return
    el.getBoundingClientRect()
    el.classList.add('highlight-pill-moves')
  })
  return ref
}

function sameItems(a: unknown[] | null, b: unknown[] | null): boolean {
  if (!a || !b) return a === b
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
}
